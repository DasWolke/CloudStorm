import { EventEmitter } from "node:events";
import DiscordConnector = require("./DiscordConnector");

import type { ShardEvents } from "./Types";

/**
 * Shard class, which provides a wrapper around the DiscordConnector with metadata like the id of the shard.
 *
 * This class is automatically instantiated by the library and is documented for reference.
 * @since 0.1.4
 */
class Shard extends EventEmitter<ShardEvents> {
	/** If this shard has received the READY or RESUMED payload and isn't disconnected yet. */
	public ready = false;
	/** The connector that handles all of the Discord specific connection logic. */
	public connector: DiscordConnector;

	/**
	 * Create a new Shard.
	 * @param id id of the shard.
	 * @param client Main class used for forwarding events.
	 */
	public constructor(public id: number, public client: import("./Client")) {
		super();

		this.connector = new DiscordConnector(id, client);
		this.connector.on("disconnect", (...args) => {
			this.ready = false;
			this.emit("disconnect", ...args);
		});
		this.connector.on("ready", resume => this.emit("ready", resume));
		this.connector.on("queueIdentify", () => this.emit("queueIdentify", this.id));
	}

	/**
	 * Time in ms it took for Discord to acknowledge an OP 1 HEARTBEAT.
	 * @since 0.3.0
	 */
	public get latency(): number {
		return this.connector.latency;
	}

	/**
	 * Create a new connection to Discord.
	 * @since 0.1.4
	 */
	public connect(): void {
		this.connector.connect();
	}

	/**
	 * Close the current connection to Discord.
	 * @since 0.1.4
	 * @param resumable Whether to close with a code that keeps the session alive for a later resume. See DiscordConnector.disconnect.
	 */
	public disconnect(resumable = false): Promise<void> {
		return this.connector.disconnect(resumable);
	}

	/**
	 * Send an OP 3 PRESENCE_UPDATE to Discord.
	 * @since 0.3.0
	 * @param data Data to send.
	 */
	public presenceUpdate(data: Parameters<Shard["connector"]["presenceUpdate"]>["0"]): Promise<void> {
		return this.connector.presenceUpdate(data);
	}

	/**
	 * Send an OP 4 VOICE_STATE_UPDATE to Discord.
	 * @since 0.1.4
	 * @param data Data to send
	 */
	public voiceStateUpdate(data: Parameters<Shard["connector"]["voiceStateUpdate"]>["0"]): Promise<void> {
		return this.connector.voiceStateUpdate(data);
	}

	/**
	 * Send an OP 8 REQUEST_GUILD_MEMBERS to Discord.
	 * @since 0.1.4
	 * @param data Data to send.
	 */
	public requestGuildMembers(data: Parameters<Shard["connector"]["requestGuildMembers"]>["0"]): Promise<void> {
		return this.connector.requestGuildMembers(data);
	}

	/**
	 * Send an OP 31 REQUEST_SOUNDBOARD_SOUNDS to the gateway.
	 * @since 0.19.0
	 * @param guilds The guilds to get the soundboard sounds from.
	 */
	public requestSoundboardSounds(guilds: Parameters<Shard["connector"]["requestSoundboardSounds"]>["0"]): Promise<void> {
		return this.connector.requestSoundboardSounds(guilds);
	}

	/**
	 * Send an OP 43 REQUEST_CHANNEL_INFO to the gateway.
	 * @since 0.19.0
	 * @param data Data to send.
	 */
	public requestChannelInfo(data: Parameters<Shard["connector"]["requestChannelInfo"]>["0"]): Promise<void> {
		return this.connector.requestChannelInfo(data);
	}
}

export = Shard;
