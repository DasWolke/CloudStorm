import EventEmitter = require("events");

import type { SMHistory, SMState, SMTransition } from "./Types";

interface StateMachineEvents {
	enter: [string];
}

class StateMachine extends EventEmitter<StateMachineEvents> {
	public readonly states = new Map<string, SMState>();
	private editable = true;
	private readonly deferredTransitionCreators: Array<() => unknown> = [];
	private readonly history: Array<SMHistory> = [];

	public constructor(public currentStateName: string) {
		super();
		this.deferredTransitionCreators.push(() => {
			if (!this.states.has(currentStateName)) {
				this.defineState(currentStateName);
			}
		});
	}

	public guardEditable() {
		if (!this.editable) throw new Error("tried to edit state machine after machine has been frozen");
	}

	public guardNotEditable() {
		if (this.editable) throw new Error("tried to do transition before machine has been frozen");
	}

	public defineState(name: string, cbs: { onEnter: SMState["onEnter"], onLeave: SMState["onLeave"], transitions: Map<string, SMTransition> } = { onEnter: [], onLeave: [], transitions: new Map() }): this {
		this.guardEditable();
		if (this.states.has(name)) throw new Error(`attempt to redefine state ${name}, please edit it instead`);
		this.states.set(name, {
			onEnter: cbs.onEnter,
			onLeave: cbs.onLeave,
			transitions: cbs.transitions
		});
		return this;
	}

	public defineTransition(from: string, event, to: string, cb?: (...args: any[]) => unknown): this {
		this.guardEditable();
		const state = this.states.get(from)!;
		if (state.transitions.has(event)) throw new Error(`attempt to redefine transition ${from} --${event}--> *, please only create transitions once`);
		const onTransition: SMTransition["onTransition"] = [];
		if (cb) onTransition.push(cb);
		state.transitions.set(event, { destination: to, onTransition });
		return this;
	}

	public defineUniversalTransition(event: string, to: string): this {
		this.guardEditable();
		this.deferredTransitionCreators.push(() => {
			for (const [stateName, state] of this.states.entries()) {
				if (!state.transitions.has(event)) {
					this.defineTransition(stateName, event, to);
				}
			}
		});
		return this;
	}

	public freeze() {
		this.guardEditable();

		// Add deferred transitions
		for (const cb of this.deferredTransitionCreators) {
			cb();
		}

		// Check consistency
		const problems: Array<string> = [];
		for (const [stateName, state] of this.states.entries()) {
			for (const [transitionName, transition] of state.transitions.entries()) {
				if (!this.states.has(transition.destination)) {
					problems.push(`transition ${stateName} --${transitionName}--> ${transition.destination} has an invalid destination`);
				}
			}
		}
		if (problems.length) {
			throw new Error(`Consistency problems in state machine: ${problems.join(";")}`);
		}

		this.editable = false;
	}

	public doTransition(event: string, ...args: any[]): void {
		this.guardNotEditable();
		const from = this.currentStateName;
		const currentState = this.states.get(this.currentStateName)!;
		const transition = currentState.transitions.get(event);
		if (!transition) throw new Error(`undefined transition: ${this.currentStateName} -> ${event} -> ?`);

		this.history.push({ from, event, to: transition.destination, time: Date.now() });
		if (this.history.length > 20) this.history.shift();

		// Leave state
		for (const cb of this.states.get(this.currentStateName)!.onLeave) {
			try {
				cb(event);
			} catch (e) {
				this.debug();
				throw new Error(`onLeave callback for state ${from} (during transition ${from} --${event}--> ${transition.destination})`, {cause: e});
			}
		}

		// Do transition
		this.currentStateName = transition.destination;
		for (const cb of transition.onTransition ?? []) {
			try {
				cb(...args);
			} catch (e) {
				this.debug();
				throw new Error(`onTransition callback during ${from} --${event}--> ${transition.destination}`, {cause: e});
			}
		}

		// Enter state
		this.emit("enter", this.currentStateName);
		for (const cb of this.states.get(this.currentStateName)!.onEnter) {
			try {
				cb(event);
			} catch (e) {
				this.debug();
				throw new Error(`onEnter callback for state ${from} (during transition ${this.currentStateName} --${event}--> ${transition.destination})`, {cause: e});
			}
		}
	}

	public doTransitionLater(event: string, delayMs: number, ...args: Array<any>): void {
		this.guardNotEditable();
		const timer = setTimeout(() => {
			this.doTransition(event, ...args);
		}, delayMs);
		this.once("enter", () => {
			clearTimeout(timer);
		});
	}

	public debug(): void {
		console.table(this.history.map(h => ({
			"At": new Date(h.time),
			"From -->": h.from,
			"-- Event -->": h.event,
			"--> To": h.to
		})).concat({
			"At": new Date(),
			"From -->": this.currentStateName,
			"-- Event -->": "(debug)",
			"--> To": ""
		}));
	}
}


export = StateMachine;
