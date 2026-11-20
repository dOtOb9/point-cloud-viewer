import { describe, expect, it } from "vitest";
import { createProgram, type Effect, type Update } from "./tea";

type Msg =
  | { type: "add"; amount: number }
  | { type: "noop" }
  | { type: "failed"; error: unknown }
  | { type: "run"; effects: Effect<Msg>[] };

interface Model {
  total: number;
  log: string[];
}

const update: Update<Model, Msg> = (model, msg) => {
  switch (msg.type) {
    case "add":
      return [{ total: model.total + msg.amount, log: [...model.log, `add ${msg.amount}`] }, []];
    case "noop":
      return [model, []];
    case "failed":
      return [{ ...model, log: [...model.log, `failed ${msg.error instanceof Error ? msg.error.message : String(msg.error)}`] }, []];
    case "run":
      return [model, msg.effects];
  }
};

const toFailed = (error: unknown): Msg => ({ type: "failed", error });

function makeProgram(reported: unknown[] = []) {
  return createProgram<Model, Msg>({ total: 0, log: [] }, update, { effectFailed: toFailed, report: (error) => reported.push(error) });
}

function throwing<M = Msg>(message: string): Effect<M> {
  return () => {
    throw new Error(message);
  };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createProgram", () => {
  it("starts from the initial model", () => {
    expect(makeProgram().getModel()).toEqual({ total: 0, log: [] });
  });

  it("runs the effects in the order update returned them", () => {
    const program = makeProgram();
    const ran: string[] = [];
    program.dispatch({ type: "run", effects: [() => void ran.push("first"), () => void ran.push("second"), () => void ran.push("third")] });
    expect(ran).toEqual(["first", "second", "third"]);
  });

  it("delivers a msg dispatched synchronously inside an effect to the next update", () => {
    const program = makeProgram();
    program.dispatch({ type: "run", effects: [(dispatch) => dispatch({ type: "add", amount: 2 })] });
    expect(program.getModel().total).toBe(2);
  });

  it("delivers a msg dispatched after an await inside an effect to the next update", async () => {
    const program = makeProgram();
    program.dispatch({
      type: "run",
      effects: [
        async (dispatch) => {
          await nextTick();
          dispatch({ type: "add", amount: 5 });
        },
      ],
    });
    expect(program.getModel().total).toBe(0);
    await nextTick();
    await nextTick();
    expect(program.getModel().total).toBe(5);
  });

  it("turns an effect that throws synchronously into a msg for update", () => {
    const program = makeProgram();
    program.dispatch({
      type: "run",
      effects: [
        () => {
          throw new Error("boom");
        },
      ],
    });
    expect(program.getModel().log).toEqual(["failed boom"]);
  });

  it("turns an effect whose promise rejects into a msg for update", async () => {
    const program = makeProgram();
    program.dispatch({ type: "run", effects: [() => Promise.reject(new Error("later"))] });
    await nextTick();
    expect(program.getModel().log).toEqual(["failed later"]);
  });

  it("keeps running the remaining effects after one throws", () => {
    const program = makeProgram();
    program.dispatch({
      type: "run",
      effects: [
        () => {
          throw new Error("boom");
        },
        (dispatch) => dispatch({ type: "add", amount: 1 }),
      ],
    });
    expect(program.getModel().log).toEqual(["failed boom", "add 1"]);
  });

  it("calls subscribers only when the model changes", () => {
    const program = makeProgram();
    let calls = 0;
    program.subscribe(() => calls++);
    program.dispatch({ type: "noop" });
    expect(calls).toBe(0);
    program.dispatch({ type: "add", amount: 1 });
    expect(calls).toBe(1);
  });

  it("stops calling a subscriber after it unsubscribes", () => {
    const program = makeProgram();
    let calls = 0;
    const unsubscribe = program.subscribe(() => calls++);
    unsubscribe();
    program.dispatch({ type: "add", amount: 1 });
    expect(calls).toBe(0);
  });

  it("queues a msg dispatched while another is being processed after the current one", () => {
    const program = makeProgram();
    const seen: string[] = [];
    program.subscribe(() => {
      const { log } = program.getModel();
      seen.push(log[log.length - 1]);
      if (log.length === 1) program.dispatch({ type: "add", amount: 10 });
    });
    program.dispatch({
      type: "run",
      effects: [
        (dispatch) => {
          dispatch({ type: "add", amount: 1 });
          dispatch({ type: "add", amount: 2 });
        },
      ],
    });
    expect(program.getModel().log).toEqual(["add 1", "add 2", "add 10"]);
    expect(seen).toEqual(["add 1", "add 2", "add 10"]);
  });

  it("runs the effects of a msg before the msgs those effects dispatched", () => {
    const program = makeProgram();
    const ran: string[] = [];
    program.dispatch({
      type: "run",
      effects: [
        (dispatch) => {
          ran.push("first effect");
          dispatch({ type: "run", effects: [() => void ran.push("effect of the queued msg")] });
        },
        () => void ran.push("second effect"),
      ],
    });
    expect(ran).toEqual(["first effect", "second effect", "effect of the queued msg"]);
  });
it("reports, instead of feeding back to update, an effect that fails while update handles an effect failure", () => {
    const reported: unknown[] = [];
    let updates = 0;
    const program = createProgram<number, "start" | "failed">(
      0,
      (model, msg) => {
        updates++;
        return [model, [msg === "start" ? throwing("first") : throwing("again")]];
      },
      { effectFailed: () => "failed", report: (error) => reported.push(error) },
    );
    program.dispatch("start");
    expect(updates).toBe(2);
    expect(reported.map((e) => (e as Error).message)).toEqual(["again"]);
  });

  it("reports a promise that rejects while update handles an effect failure", async () => {
    const reported: unknown[] = [];
    const program = createProgram<number, "start" | "failed">(
      0,
      (model, msg) => [model, [msg === "start" ? () => Promise.reject(new Error("first")) : () => Promise.reject(new Error("again"))]],
      { effectFailed: () => "failed", report: (error) => reported.push(error) },
    );
    program.dispatch("start");
    await nextTick();
    await nextTick();
    expect(reported.map((e) => (e as Error).message)).toEqual(["again"]);
  });

  it("treats msgs dispatched by the effects of a failure msg as ordinary msgs again", () => {
    const program = makeProgram();
    program.dispatch({ type: "run", effects: [throwing("boom"), (dispatch) => dispatch({ type: "run", effects: [throwing("later")] })] });
    expect(program.getModel().log).toEqual(["failed boom", "failed later"]);
  });

  it("reports a subscriber that throws and still runs the effects and the other subscribers", () => {
    const reported: unknown[] = [];
    const program = makeProgram(reported);
    let otherCalls = 0;
    program.subscribe(() => {
      throw new Error("listener failed");
    });
    program.subscribe(() => otherCalls++);
    const ran: string[] = [];
    program.dispatch({ type: "add", amount: 1 });
    program.dispatch({ type: "run", effects: [(dispatch) => dispatch({ type: "add", amount: 1 }), () => void ran.push("effect")] });
    expect(otherCalls).toBe(2);
    expect(ran).toEqual(["effect"]);
    expect(reported.map((e) => (e as Error).message)).toEqual(["listener failed", "listener failed"]);
  });
  it("reports both errors when effectFailed itself throws, and keeps the program usable", () => {
    const reported: unknown[] = [];
    const program = createProgram<number, "start" | "add">(
      0,
      (model, msg) => (msg === "start" ? [model, [throwing("effect")]] : [model + 1, []]),
      {
        effectFailed: () => {
          throw new Error("conversion");
        },
        report: (error) => reported.push(error),
      },
    );
    expect(() => program.dispatch("start")).not.toThrow();
    expect(reported.map((e) => (e as Error).message)).toEqual(["effect", "conversion"]);
    program.dispatch("add");
    expect(program.getModel()).toBe(1);
  });
});
