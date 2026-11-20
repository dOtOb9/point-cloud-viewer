export type Dispatch<Msg> = (msg: Msg) => void;
export type Effect<Msg> = (dispatch: Dispatch<Msg>) => void | Promise<void>;
export type Update<Model, Msg> = (model: Model, msg: Msg) => [Model, Effect<Msg>[]];
export type EffectFailed<Msg> = (error: unknown) => Msg;

export interface Failures<Msg> {
  effectFailed: EffectFailed<Msg>;
  report(error: unknown): void;
}

export interface Program<Model, Msg> {
  getModel(): Model;
  dispatch(msg: Msg): void;
  subscribe(listener: () => void): () => void;
}

interface Queued<Msg> {
  msg: Msg;
  isEffectFailure: boolean;
}

export function createProgram<Model, Msg>(init: Model, update: Update<Model, Msg>, failures: Failures<Msg>): Program<Model, Msg> {
  let model = init;
  const listeners = new Set<() => void>();
  const queue: Queued<Msg>[] = [];
  let processing = false;

  function enqueue(entry: Queued<Msg>): void {
    queue.push(entry);
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) step(queue.shift() as Queued<Msg>);
    } finally {
      processing = false;
    }
  }

  function dispatch(msg: Msg): void {
    enqueue({ msg, isEffectFailure: false });
  }

  function step({ msg, isEffectFailure }: Queued<Msg>): void {
    const [next, effects] = update(model, msg);
    if (!Object.is(next, model)) {
      model = next;
      notifyListeners();
    }
    for (const effect of effects) runEffect(effect, isEffectFailure);
  }

  function notifyListeners(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        failures.report(error);
      }
    }
  }

  function effectFailed(error: unknown, whileHandlingEffectFailure: boolean): void {
    if (whileHandlingEffectFailure) {
      failures.report(error);
      return;
    }
    let msg: Msg;
    try {
      msg = failures.effectFailed(error);
    } catch (conversionError) {
      failures.report(error);
      failures.report(conversionError);
      return;
    }
    enqueue({ msg, isEffectFailure: true });
  }

  function runEffect(effect: Effect<Msg>, whileHandlingEffectFailure: boolean): void {
    let result: void | Promise<void>;
    try {
      result = effect(dispatch);
    } catch (error) {
      effectFailed(error, whileHandlingEffectFailure);
      return;
    }
    if (result instanceof Promise) result.catch((error: unknown) => effectFailed(error, whileHandlingEffectFailure));
  }

  return {
    getModel: () => model,
    dispatch,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
