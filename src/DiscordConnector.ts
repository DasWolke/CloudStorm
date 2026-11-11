import { EventEmitter } from "node:events";
import { isIP } from "node:net";
import BetterWs = require("./BetterWs");
import { GATEWAY_OP_CODES as OP, getGatewayAddress } from "./Constants";
import Intents = require("./Intents");
import { clientError, safeEmit } from "./safeEmit";

import { Bucket, IntervalCounter, StateMachine, type Counter, type SMTransition } from "snowtransfer";

import {
	type GatewayReceivePayload,
	type GatewayIdentify,
	type GatewayPresenceUpdateData,
	type GatewayVoiceStateUpdateData,
	type GatewayRequestGuildMembersData,
	type GatewayRequestGuildMembersDataWithQuery,
	type GatewayRequestGuildMembersDataWithUserIds,
	type GatewaySendPayload,

	PresenceUpdateStatus,
	GatewayRequestChannelInfoData
} from "discord-api-types/v10";

import type {
	ConnectorEvents,
	IGatewayMessage,
	IGatewayDispatch,
	IShardResumeData
} from "./Types";

const resumableCodes = new Set([4008, 4005, 4003, 4002, 4001, 4000, 1006, 1001]);
const shouldntAttemptReconnectCodes = new Set([4014, 4013, 4012, 4011, 4010, 4004]);
const disconnectMessages = {
	4014: "Disallowed Intents, check your client options and application page.",
	4013: "Invalid Intents data, check your client options.",
	4012: "Invalid API version.",
	4011: "Shard would be on over 2500 guilds. Add more shards.",
	4010: "Invalid sharding data, check your client options.",
	4009: "Session timed out.",
	4008: "You are being rate limited. Wait before sending more packets.",
	4007: "Invalid sequence. Reconnecting and starting a new session.",
	4005: "You sent more than one OP 2 IDENTIFY payload while the websocket was open.",
	4004: "Tried to connect with an invalid token.",
	4003: "You tried to send a packet before sending an OP 2 IDENTIFY or OP 6 RESUME.",
	4002: "You sent an invalid payload.",
	4001: "You sent an invalid opcode or invalid payload for an opcode."
};
const tlsProtocols = /^(wss|https):$/;

/**
 * If a seeded resume address may be sent the token: only the gateway endpoint's own host or a sibling under its domain,
 * and never over plain text when the endpoint is encrypted.
 * @since 0.20.0
 */
function trustsResumeAddress(address: string, endpoint: string): boolean {
	try {
		const resume = new URL(address);
		const identify = new URL(endpoint);
		if (tlsProtocols.test(identify.protocol) && !tlsProtocols.test(resume.protocol)) return false;
		if (resume.hostname === identify.hostname) return true;
		const labels = identify.hostname.split(".");
		return !isIP(identify.hostname) && labels.length > 2 && resume.hostname.endsWith(`.${labels.slice(1).join(".")}`);
	} catch {
		return false;
	}
}

/**
 * Counts every take within the trailing window. IntervalCounter refills all at once when its window ends,
 * so a burst at the end of one window plus another at the start of the next could double Discord's limit.
 * @since 0.20.0
 */
class SlidingCounter implements Counter {
	private readonly _takes: Array<number> = [];

	public constructor(public limit: number, public window: number, public readonly id: string) {}

	private _prune(): void {
		const cutoff = Date.now() - this.window;
		while (this._takes.length && this._takes[0] <= cutoff) {
			this._takes.shift();
		}
	}

	public hasReset(): boolean {
		this._prune();
		return !this._takes.length;
	}

	public canTake(): boolean {
		this._prune();
		return this._takes.length < this.limit;
	}

	public take(): boolean {
		if (!this.canTake()) return false;
		this._takes.push(Date.now());
		return true;
	}

	public timeUntilReset(): number {
		return this.canTake() ? 0 : this._takes[0] + this.window - Date.now();
	}

	public responseReceived(): void { void 0; }

	public applyCount(): void { void 0; }
}

/**
 * Class used for acting based on received events.
 *
 * This class is automatically instantiated by the library and is documented for reference.
 * @since 0.1.4
 */
class DiscordConnector extends EventEmitter<ConnectorEvents> {
	/** The options used by the client */
	public options: DiscordConnector["client"]["options"];
	/** The WebSocket this connector uses */
	public betterWs: BetterWs;
	/** A Timeout that, when triggered, will send an op 1 heartbeat. Is null if Discord hasn't told this connector how often to heartbeat */
	public heartbeatTimeout: globalThis.NodeJS.Timeout | null = null;
	/** How often this connector should heartbeat if not 0 */
	public heartbeatInterval = 0;
	/** The sequence, which is the number of events received by Discord within the session if any session */
	public seq = 0;
	/** The status of this connector */
	public status: "connecting" | "identifying" | "resuming" | "ready" | "disconnected" = "disconnected";
	/** The session ID used for resuming or null if Discord hasn't sent one yet */
	public sessionId: string | null = null;
	/** The ms timestamp when this connector last received an op 11 heartbeat ack if not 0 */
	public lastACKAt = 0;
	/** The ms timestamp when this connector last sent an op 1 heartbeat if not 0 */
	public lastHeartbeatSend = 0;
	/** The time in milliseconds it took for Discord to send an op 11 heartbeat ack in response to an op 1 heartbeat */
	public latency = 0;
	/** The address the WebSocket will use to connect to the Discord gateway if resuming */
	public resumeAddress: string | null = null;
	/**
	 * Tracks the session lifecycle this connector is in and what operations are allowed.
	 * States: disconnected, connecting (awaiting HELLO), identifying, resuming, ready,
	 * closing (user-requested disconnect in flight), reconnecting (deliberate close that will reconnect).
	 */
	public sm = new StateMachine("disconnected");
	/** The ratelimit bucket for how many packets this ws can send within a time frame. Discord allows 120/60s; 5 are left for the identify, resume and heartbeats that skip it. */
	public wsBucket = new Bucket([new SlidingCounter(115, 60000, "ws")]);
	/** The ratelimit bucket for how many presence update specific packets this ws can send within a time frame. Is still affected by the overall packet send bucket. */
	public presenceBucket = new Bucket([new SlidingCounter(5, 60000, "presence")]);
	/** The ratelimit bucket for when requesting all guild members from a guild. Is still affected by the overall packet send bucket. */
	public membersBucket = new Bucket([new IntervalCounter(1, 30000)]);

	/** A Timeout that, when triggered, closes the connection because op HELLO hasn't been received and may never be received */
	private _openToHeartbeatTimeout: globalThis.NodeJS.Timeout | null = null;
	/** If an OP 2 IDENTIFY or OP 6 RESUME was already sent on the current ws connection and is still authoritative for it */
	private _authSent = false;
	/** If the close in flight was requested as not resumable, which ends the session no matter what code the close arrives with */
	private _dropSession = false;
	/** A Timeout that, when triggered, sends the first heartbeat */
	private _initialHeartbeatTimeout: globalThis.NodeJS.Timeout | null = null;
	/** A Timeout that, when triggered, resumes or queues an identify after an OP 9 INVALID_SESSION */
	private _invalidSessionTimeout: globalThis.NodeJS.Timeout | null = null;

	/**
	 * The address the WebSocket will use to connect to the Discord gateway if not resuming.
	 * Always reads the client's current endpoint, so a later Client.fetchConnectInfo() call is picked up by existing shards.
	 */
	public get identifyAddress(): string {
		return this.options.endpoint!;
	}

	/**
	 * Creates a new Discord Connector.
	 * @param id id of the shard that created this class.
	 * @param client Main client instance.
	 */
	public constructor(public id: number, public client: import("./Client")) {
		super();

		this.options = client.options;

		// identifying, resuming and ready share these: Discord may invalidate the session or replay at any point after HELLO
		const sessionTransitions = (): Map<string, SMTransition> => new Map([
			["identify_started", { destination: "identifying" }],
			["resume_started", { destination: "resuming" }],
			["ready_received", { destination: "ready" }],
			["reconnect_requested", { destination: "reconnecting" }]
		]);

		this.sm.defineState("disconnected", {
			onEnter: [],
			onLeave: [],
			transitions: new Map([
				["connect_started", { destination: "connecting" }]
			])
		});
		this.sm.defineState("connecting", {
			onEnter: [],
			onLeave: [],
			transitions: new Map([
				["identify_started", { destination: "identifying" }],
				["resume_started", { destination: "resuming" }],
				["reconnect_requested", { destination: "reconnecting" }]
			])
		});
		this.sm.defineState("identifying", { onEnter: [], onLeave: [], transitions: sessionTransitions() });
		this.sm.defineState("resuming", { onEnter: [], onLeave: [], transitions: sessionTransitions() });
		this.sm.defineState("ready", { onEnter: [], onLeave: [], transitions: sessionTransitions() });
		// Both closing and reconnecting wait for the ws to fully close. Which one the close arrives in decides manual/graceful in handleWsClose
		this.sm.defineState("closing", {
			onEnter: [],
			onLeave: [],
			transitions: new Map([
				// connect() while a disconnect is still closing flips the intent: finish the close, then reconnect
				["connect_started", { destination: "reconnecting" }]
			])
		});
		this.sm.defineState("reconnecting", {
			onEnter: [],
			onLeave: [],
			transitions: new Map([
				["reconnect_requested", { destination: "reconnecting" }]
			])
		});
		this.sm.defineUniversalTransition("close_requested", "closing");
		this.sm.defineUniversalTransition("ws_closed", "disconnected");
		this.sm.freeze();

		this.betterWs = new BetterWs(this.identifyAddress, this.options.ws!);

		this.betterWs.on("ws_open", () => {
			this.status = "connecting";
			this._openToHeartbeatTimeout = setTimeout(() => {
				safeEmit(this._clientError, () => this.client.emit("debug", `Shard ${this.id} didn't receive a HELLO after the ws was opened in time`));
				this._reconnect().catch(this._clientError);
			}, 10000);
		});
		this.betterWs.on("ws_receive", msg => this.messageAction(msg));
		this.betterWs.on<"ws_close">("ws_close", (code, reason) => this.handleWsClose(code, reason));
		this.betterWs.on("debug", event => safeEmit(this._clientError, () => this.client.emit("debug", `Shard ${this.id} ${event}`)));
		this.betterWs.on("error", event => this._clientError(event));
		this.betterWs.on("ws_send", data => {
			// identify and resume carry the token, and rawSend tends to end up in logs
			const redacted = data?.d?.token ? { ...data, d: { ...data.d, token: "[redacted]" } } : data;
			safeEmit(this._clientError, () => this.client.emit("rawSend", redacted));
		});

		this._pauseBuckets();
	}

	/**
	 * Emit an error on the client if anyone listens for them, otherwise downgrade to a debug event.
	 * @since 0.19.0
	 */
	private readonly _clientError = (error: Error): void => clientError(this.client, error, `Shard ${this.id} `);

	/**
	 * Pause all send ratelimit buckets, queueing further messages until resumed.
	 * @since 0.19.0
	 */
	private _pauseBuckets(): void {
		this.wsBucket.pause();
		this.presenceBucket.pause();
		this.membersBucket.pause();
	}

	/**
	 * Resume all send ratelimit buckets.
	 * @since 0.19.0
	 */
	private _resumeBuckets(): void {
		this.wsBucket.resume();
		this.presenceBucket.resume();
		this.membersBucket.resume();
	}

	/**
	 * Connect to Discord.
	 * @since 0.1.4
	 */
	public connect(): void {
		const state = this.sm.currentStateName;
		if (state !== "disconnected" && state !== "closing") return;
		safeEmit(this._clientError, () => this.client.emit("debug", `Shard ${this.id} connecting to gateway`));
		this.sm.doTransition("connect_started");
		this.betterWs.address = this.sessionId && this.resumeAddress ? this.resumeAddress : this.identifyAddress;
		return this.betterWs.connect();
	}

	/**
	 * Snapshot of everything needed to resume this shard's session, e.g. in another process.
	 * Only meaningful after the session was established and the connection wasn't closed with a
	 * session-destroying code (1000/1001) - see disconnect(resumable).
	 * @since 0.19.0
	 * @returns The resume data, or null if there is no session to resume.
	 */
	public getResumeData(): IShardResumeData | null {
		if (!this.sessionId) return null;
		return {
			sessionId: this.sessionId,
			seq: this.seq,
			resumeAddress: this.resumeAddress
		};
	}

	/**
	 * Seed this connector with resume data from a previous process, making the next connect
	 * resume the session instead of identifying. If Discord no longer accepts the session,
	 * the connector falls back to identifying automatically via INVALID_SESSION.
	 * A resume address that isn't on the gateway endpoint's host or domain is ignored and the resume goes to the endpoint.
	 * @since 0.19.0
	 * @param data Resume data as returned by getResumeData().
	 */
	public seedResumeData(data: IShardResumeData): void {
		this.sessionId = data.sessionId ?? null;
		this.seq = data.seq ?? 0;
		this.resumeAddress = data.resumeAddress && trustsResumeAddress(data.resumeAddress, this.identifyAddress) ? data.resumeAddress : null;
		if (data.resumeAddress && !this.resumeAddress) this._clientError(new Error(`Shard ${this.id} ignored the seeded resume address ${data.resumeAddress} because it is not on the gateway endpoint's host`));
	}

	/**
	 * Close the websocket connection and disconnect.
	 * @since 0.1.4
	 * @param resumable Whether to close with a code that keeps the session alive on Discord's end,
	 * so it can be resumed later - also from another process via getResumeData()/seeded resume data.
	 * The default close code 1000 destroys the session.
	 */
	public async disconnect(resumable = false): Promise<void> {
		this._pauseBuckets();
		this.clearHeartBeat();
		if (this.betterWs.sm.currentStateName === "disconnected") return;
		this._dropSession = !resumable;
		this.sm.doTransition("close_requested");
		// also cancels a connect still waiting/in flight
		return this.betterWs.close(resumable ? 4000 : 1000, resumable ? "Disconnecting with intent to resume" : "Disconnected by User");
	}

	/**
	 * Called with a parsed Websocket message to execute further actions.
	 * @since 0.1.4
	 * @param message Message that was received.
	 */
	private messageAction(message: GatewayReceivePayload): void {
		safeEmit(this._clientError, () => this.client.emit("rawReceive", message));
		const withShardID: IGatewayMessage = Object.assign(message, { shard_id: this.id });
		safeEmit(this._clientError, () => this.client.emit("event", withShardID));

		switch (withShardID.op) {
		case OP.DISPATCH:
			this.handleDispatch(withShardID);
			break;

		case OP.HEARTBEAT:
			this.heartbeat();
			break;

		case OP.RECONNECT:
			safeEmit(this._clientError, () => this.client.emit("debug", `Gateway asked shard ${this.id} to reconnect`));
			this._reconnect().catch(this._clientError);
			break;

		case OP.INVALID_SESSION:
			safeEmit(this._clientError, () => this.client.emit("debug", `Shard ${this.id}'s session was invalidated`));
			if (!withShardID.d || !this.sessionId) {
				this.seq = 0;
				this.sessionId = null;
				this._authSent = false; // Discord explicitly wants a fresh identify on this same connection
			}
			// Anything but an identify or resume sent before Discord accepts one gets the connection closed with a 4003
			this._pauseBuckets();
			this.status = "connecting";
			// Discord asks for a random 1-5s wait before resuming or identifying again
			if (this._invalidSessionTimeout) clearTimeout(this._invalidSessionTimeout);
			this._invalidSessionTimeout = setTimeout(() => {
				this._invalidSessionTimeout = null;
				if (this.sessionId) this.resume().catch(this._clientError);
				else safeEmit(this._clientError, () => this.emit("queueIdentify", this.id));
			}, 1000 + Math.random() * 4000);
			break;

		case OP.HELLO:
			if (this._openToHeartbeatTimeout) clearTimeout(this._openToHeartbeatTimeout);
			safeEmit(this._clientError, () => this.client.emit("debug", `Shard ${this.id} received HELLO`));
			this.lastACKAt = Date.now();
			this.heartbeatInterval = withShardID.d.heartbeat_interval;
			this._initialHeartbeatTimeout = setTimeout(() => this.heartbeat(), this.heartbeatInterval * Math.random());
			if (this.sessionId) return void this.resume().catch(this._clientError);
			else safeEmit(this._clientError, () => this.emit("queueIdentify", this.id));
			break;

		case OP.HEARTBEAT_ACK:
			this.lastACKAt = Date.now();
			this.latency = this.lastACKAt - this.lastHeartbeatSend;
			break;

		default:
			void 0;
		}
	}

	/**
	 * Deliberately close the connection with a resumable code, then reconnect and resume the session.
	 * If the session turns out to not be resumable, the INVALID_SESSION flow falls back to identifying.
	 * @since 0.3.0
	 */
	private async _reconnect(): Promise<void> {
		if (this.sm.currentStateName === "closing") return; // a user-requested disconnect wins over automatic reconnects
		const state = this.betterWs.sm.currentStateName;
		if (state !== "connected" && state !== "half_close") return;
		this.sm.doTransition("reconnect_requested");
		this._pauseBuckets();
		this.clearHeartBeat();
		await this.betterWs.close(4000, "reconnecting");
	}

	/**
	 * Sets the this.heartbeatTimeout Interval.
	 * @since 0.8.5
	 */
	private setHeartBeat(): void {
		this.heartbeatTimeout = setInterval(() => {
			if (this.lastACKAt <= Date.now() - (this.heartbeatInterval + 5000)) {
				safeEmit(this._clientError, () => this.client.emit("debug", `Shard ${this.id} has not received a heartbeat ACK in ${this.heartbeatInterval + 5000}ms.`));
				this._reconnect().catch(this._clientError);
			} else this.heartbeat();
		}, this.heartbeatInterval);
	}

	/**
	 * Clear the heart beat interval, set it to null and set the cached heartbeat_interval as 0.
	 * @since 0.3.0
	 */
	private clearHeartBeat(): void {
		if (this.heartbeatTimeout) clearInterval(this.heartbeatTimeout);
		if (this._initialHeartbeatTimeout) clearTimeout(this._initialHeartbeatTimeout);
		if (this._openToHeartbeatTimeout) clearTimeout(this._openToHeartbeatTimeout);
		if (this._invalidSessionTimeout) clearTimeout(this._invalidSessionTimeout);
		this.heartbeatTimeout = null;
		this._initialHeartbeatTimeout = null;
		this._openToHeartbeatTimeout = null;
		this._invalidSessionTimeout = null;
		this.heartbeatInterval = 0;
	}

	/**
	 * Send an OP 2 IDENTIFY to the gateway.
	 * @since 0.1.4
	 */
	public async identify(): Promise<void> {
		if (this.betterWs.sm.currentStateName !== "connected") {
			this._clientError(new Error(`Shard ${this.id} was attempting to identify when the ws was not open. Current state: ${this.betterWs.sm.currentStateName}`));
			return this._reconnect();
		}
		if (this._authSent) {
			// A stale queued identify from before a reconnect. The identify or resume already sent on this connection
			// is the authoritative one; identifying on top of it would get the session closed with a 4005
			safeEmit(this._clientError, () => this.client.emit("debug", `Shard ${this.id} skipped a duplicate identify on the same connection`));
			return;
		}
		this._authSent = true;
		safeEmit(this._clientError, () => this.client.emit("debug", `Shard ${this.id} is identifying`));

		this.sm.doTransition("identify_started");
		this.status = "identifying";

		const data = {
			op: OP.IDENTIFY,
			d: {
				token: this.options.token,
				properties: {
					os: process.platform,
					browser: "CloudStorm",
					device: "CloudStorm"
				},
				large_threshold: this.options.largeGuildThreshold,
				shard: [this.id, this.options.totalShards ?? 1],
				intents: this.options.intents ? Intents.resolve(this.options.intents) : 0
			}
		} as GatewayIdentify;

		if (this.options.initialPresence) data.d.presence = this._checkPresenceData(this.options.initialPresence);
		this.betterWs.sendMessage(data);
	}

	/**
	 * Send an OP 6 RESUME to the gateway.
	 * @since 0.1.4
	 */
	public async resume(): Promise<void> {
		if (this.betterWs.sm.currentStateName !== "connected") {
			this._clientError(new Error(`Shard ${this.id} was attempting to resume when the ws was not open. Current state: ${this.betterWs.sm.currentStateName}`));
			return this._reconnect();
		}
		safeEmit(this._clientError, () => this.client.emit("debug", `Shard ${this.id} is resuming`));

		this._authSent = true;
		this.sm.doTransition("resume_started");
		this.status = "resuming";

		this.betterWs.sendMessage({
			op: OP.RESUME,
			d: { seq: this.seq, token: this.options.token, session_id: this.sessionId! }
		});
	}

	/**
	 * Send an OP 1 HEARTBEAT to the gateway.
	 * @since 0.1.4
	 */
	private heartbeat(): void {
		const state = this.betterWs.sm.currentStateName;
		if (state === "half_close") return; // a close is already in flight. Don't heartbeat into it or treat it as a dead connection
		if (state !== "connected") {
			this._clientError(new Error(`Shard ${this.id} was attempting to heartbeat when the ws was not open. Current state: ${state}`));
			return void this._reconnect().catch(this._clientError);
		}
		this.betterWs.sendMessage({ op: OP.HEARTBEAT, d: this.seq === 0 ? null : this.seq });
		this.lastHeartbeatSend = Date.now();
		if (this._initialHeartbeatTimeout) {
			clearTimeout(this._initialHeartbeatTimeout);
			this._initialHeartbeatTimeout = null;
		}
		if (!this.heartbeatTimeout && this.heartbeatInterval > 0) this.setHeartBeat();
	}

	/**
	 * Handle dispatch events.
	 * @since 0.1.4
	 * @param message Message received from the websocket.
	 */
	private handleDispatch(message: IGatewayDispatch): void {
		if (message.s) { // sequence is from dispatch
			if (message.s > this.seq + 1) {
				safeEmit(this._clientError, () => this.client.emit("debug", `Shard ${this.id} invalid sequence: { current: ${this.seq} message: ${message.s} }`));
				this._reconnect().catch(this._clientError);
				return;
			}
			this.seq = message.s;
		}

		safeEmit(this._clientError, () => this.client.emit("dispatch", message));

		switch (message.t) {
		case "READY":
		case "RESUMED": {
			if (message.t === "READY") {
				if (message.d.resume_gateway_url) this.resumeAddress = getGatewayAddress(message.d.resume_gateway_url, this.options.ws);
				this.sessionId = message.d.session_id;
			}
			const state = this.sm.currentStateName;
			if (state === "closing" || state === "reconnecting") {
				// The READY/RESUMED crossed a deliberate close still in flight. The connection is on its way down;
				// announcing ready would flip the status and buckets back on mid-teardown
				safeEmit(this._clientError, () => this.client.emit("debug", `Shard ${this.id} received ${message.t} while ${state} and won't announce ready`));
				break;
			}
			this.sm.doTransition("ready_received");
			this.status = "ready";
			safeEmit(this._clientError, () => this.emit("ready", message.t === "RESUMED"));
			this._resumeBuckets();
			break;
		}
		default:
			void 0;
		}
	}

	/**
	 * Handle a close from the underlying websocket.
	 * @since 0.1.4
	 * @param code Websocket close code.
	 * @param reason Close reason if any.
	 */
	private handleWsClose(code: number, reason: string): void {
		// Which state the close arrived in carries the intent: "closing" means the user asked for this
		// (even if the server echoed a code other than 1000 or never answered and this is the 1006 fallback),
		// "reconnecting" means the lib closed on purpose and will reopen.
		const stateBeforeClose = this.sm.currentStateName;
		this.sm.doTransition("ws_closed");

		this.status = "disconnected";
		this.clearHeartBeat();
		this._pauseBuckets();
		this._authSent = false; // whatever identify or resume happened belonged to the connection that just died

		const isManualClose = stateBeforeClose === "closing";
		const gracefulClose = isManualClose || stateBeforeClose === "reconnecting";

		const message = disconnectMessages[code as keyof typeof disconnectMessages];
		const isRecoverable = resumableCodes.has(code);
		const shouldntReconnect = shouldntAttemptReconnectCodes.has(code) || isManualClose;

		// The session only survives closures Discord considers resumable. Keeping it would make the next connection
		// attempt a doomed resume (e.g. after 4007/4009), wasting a round trip on INVALID_SESSION before identifying.
		// connect() picks the resume or identify address based on whether a session remains.
		// A disconnect that wasn't asked to be resumable ends it too, even when the server never answered and the close reads as a 1006.
		if (!isRecoverable || this._dropSession) {
			this.sessionId = null;
			this.seq = 0;
		}
		this._dropSession = false;

		if (message) {
			const error = new Error(message);
			// A code that stops reconnection leaves a permanently dead shard only a human can fix.
			// With no error listener, crashing is the only way that human finds out.
			if (!this.client.listenerCount("error") && shouldntAttemptReconnectCodes.has(code)) queueMicrotask(() => {
				throw error;
			});
			else this._clientError(error);
		}

		safeEmit(this._clientError, () => this.emit("disconnect", code, reason, gracefulClose, isManualClose));

		if (!shouldntReconnect) this.connect();
	}

	/**
	 * Send an OP 3 PRESENCE_UPDATE to the gateway.
	 * @since 0.3.0
	 * @param data Presence data to send.
	 */
	public async presenceUpdate(data: Partial<GatewayPresenceUpdateData>): Promise<void> {
		return this.sendMessage({ op: OP.PRESENCE_UPDATE, d: this._checkPresenceData(data) });
	}

	/**
	 * Send an OP 4 VOICE_STATE_UPDATE to the gateway.
	 * @since 0.1.4
	 * @param data Voice state update data to send.
	 */
	public async voiceStateUpdate(data: GatewayVoiceStateUpdateData & { self_deaf?: boolean; self_mute?: boolean; }): Promise<void> {
		return this.sendMessage({ op: OP.VOICE_STATE_UPDATE, d: this._checkVoiceStateUpdateData(data) });
	}

	/**
	 * Send an OP 8 REQUEST_GUILD_MEMBERS to the gateway.
	 * @since 0.1.4
	 * @param data Data to send.
	 */
	public async requestGuildMembers(data: GatewayRequestGuildMembersData & { limit?: number; }): Promise<void> {
		return this.sendMessage({ op: OP.REQUEST_GUILD_MEMBERS, d: this._checkRequestGuildMembersData(data) });
	}

	/**
	 * Send an OP 31 REQUEST_SOUNDBOARD_SOUNDS to the gateway.
	 * @since 0.19.0
	 * @param guilds The guilds to get the soundboard sounds from.
	 */
	public async requestSoundboardSounds(guilds: Array<string>): Promise<void> {
		return this.sendMessage({ op: OP.REQUEST_SOUNDBOARD_SOUNDS, d: { guild_ids: guilds } });
	}

	/**
	 * Send an OP 43 REQUEST_CHANNEL_INFO to the gateway.
	 * @since 0.19.0
	 * @param data Data to send.
	 */
	public async requestChannelInfo(data: GatewayRequestChannelInfoData): Promise<void> {
		return this.sendMessage({ op: OP.REQUEST_CHANNEL_INFO, d: data });
	}

	/**
	 * Sends a message to the server in the format of { op: number, d: any } (before any encoding/compression).
	 * @since 0.12.0
	 * @param data Packet to send to Discord.
	 * @returns A Promise that resolves when the message passes the bucket queue(s).
	 */
	public async sendMessage(data: GatewaySendPayload): Promise<void> {
		const bypass = this.options.ws!.bypassBuckets;
		return new Promise<void>((res, rej) => {
			const sendMsg = () => {
				const fn = () => {
					try {
						if (this.betterWs.sendMessage(data)) res(void 0);
						else rej(new Error(`Shard ${this.id} dropped a message because the ws was no longer writable`));
					} catch (e) {
						rej(e instanceof Error ? e : new Error(String(e)));
					}
				};
				if (bypass) fn();
				else this.wsBucket.enqueue(async () => fn()).catch(this._clientError);
			};
			if (bypass) sendMsg();
			else {
				switch (data.op) {
				case OP.PRESENCE_UPDATE:
					this.presenceBucket.enqueue(async () => sendMsg()).catch(this._clientError);
					break;
				case OP.REQUEST_GUILD_MEMBERS:
					if ("query" in data.d && data.d.query.length === 0 && data.d.limit === 0) this.membersBucket.enqueue(async () => sendMsg()).catch(this._clientError);
					else sendMsg();
					break;
				default:
					sendMsg();
					break;
				}
			}
		});
	}

	/**
	 * Checks presence data and fills in missing elements without touching the caller's object.
	 * @since 0.1.4
	 * @param data Data to send.
	 * @returns A new object with the fixed/checked data.
	 */
	private _checkPresenceData(data: Parameters<DiscordConnector["presenceUpdate"]>["0"]): GatewayPresenceUpdateData {
		const activities = (Array.isArray(data.activities) ? data.activities : [])
			.map(activity => ({ ...activity, type: activity.type ?? (activity.url ? 1 : 0) }))
			.map(activity => !activity.name && activity.state && activity.type === 4
				? { ...activity, name: "Custom Status" } // Discord requires name to not be empty even on custom status
				: activity)
			.filter(activity => activity.name);

		return {
			status: data.status ?? PresenceUpdateStatus.Online,
			activities,
			afk: data.afk ?? false,
			since: data.since ?? null
		};
	}

	/**
	 * Checks voice state update data and fills in missing elements without touching the caller's object.
	 * @since 0.1.4
	 * @param data Data to send.
	 * @returns A new object with the fixed/checked data.
	 */
	private _checkVoiceStateUpdateData(data: Parameters<DiscordConnector["voiceStateUpdate"]>["0"]): GatewayVoiceStateUpdateData {
		return {
			...data,
			channel_id: data.channel_id ?? null,
			self_mute: data.self_mute ?? false,
			self_deaf: data.self_deaf ?? false
		};
	}

	/**
	 * Checks request guild members data and fills in missing elements without touching the caller's object.
	 * @since 0.1.4
	 * @param data Data to send.
	 * @returns A new object with the fixed/checked data.
	 */
	private _checkRequestGuildMembersData(data: Parameters<DiscordConnector["requestGuildMembers"]>["0"]): GatewayRequestGuildMembersData {
		const copy = { ...data, limit: data.limit ?? 10 } as GatewayRequestGuildMembersDataWithQuery & Partial<GatewayRequestGuildMembersDataWithUserIds>;
		if (!copy.query && !copy.user_ids) copy.query = "";
		else if (copy.query && copy.user_ids) delete (copy as { query?: string; }).query; // the intention may be to get users by ID
		return copy;
	}
}

export = DiscordConnector;
