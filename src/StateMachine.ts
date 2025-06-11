import EventEmitter = require("events");

type State = {
	onEnter: Array<(event: string) => unknown>;
	onLeave: Array<(event: string) => unknown>;
	transitions: Map<string, Transition>;
}

type Transition = {
	destination: string;
	onTransition?: Array<(...args: any[]) => unknown>;
}

interface StateMachineEvents {
	enter: [string];
}

class StateMachine extends EventEmitter<StateMachineEvents> {
	public readonly states = new Map<string, State>();
	private editable = true;
	private readonly deferredTransitionCreators: Array<() => unknown> = [];

	public constructor(public currentStateName: string) {
		super()
		this.deferredTransitionCreators.push(() => {
			if (!this.states.has(currentStateName)) {
				this.defineState(currentStateName);
			}
		})
	}

	private guardEditable() {
		if (!this.editable) throw new Error("tried to edit state machine after machine has been frozen");
	}

	private guardNotEditable() {
		if (this.editable) throw new Error("tried to do transition before machine has been frozen");
	}

	public defineState(name: string, cbs: { onEnter: State["onEnter"], onLeave: State["onLeave"], transitions: Map<string, Transition> } = { onEnter: [], onLeave: [], transitions: new Map() }): this {
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
		if (state.transitions.has(event)) throw new Error(`attempt to redefine transition ${from} --${event}--> *, please only create transitions once`)
		const onTransition: Transition["onTransition"] = []
		if (cb) onTransition.push(cb)
		state.transitions.set(event, { destination: to, onTransition })
		return this
	}

	public defineUniversalTransition(event: string, to: string): this {
		this.guardEditable();
		this.deferredTransitionCreators.push(() => {
			for (const [stateName, state] of this.states.entries()) {
				if (!state.transitions.has(event)) {
					this.defineTransition(stateName, event, to);
				}
			}
		})
		return this
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
			throw new Error(`Consistency problems in state machine: ${problems.join(";")}`)
		}

		this.editable = false;
	}

	public doTransition(event: string, ...args: any[]): void {
		this.guardNotEditable();
		const currentState = this.states.get(this.currentStateName)!;
		const transition = currentState.transitions.get(event);
		if (!transition) throw new Error(`undefined transition: ${this.currentStateName} -> ${event} -> ?`);

		// Leave state
		for (const cb of this.states.get(this.currentStateName)!.onLeave) {
			cb(event);
		}

		// Do transition
		this.currentStateName = transition.destination;
		for (const cb of transition.onTransition ?? []) {
			cb(...args);
		}

		// Enter state
		this.emit("enter", this.currentStateName)
		for (const cb of this.states.get(this.currentStateName)!.onLeave) {
			cb(event);
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
}


export = StateMachine
