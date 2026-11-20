export type Dispatch<Msg> = (msg: Msg) => void;
export type Effect<Msg> = (dispatch: Dispatch<Msg>) => void | Promise<void>;
export type Update<Model, Msg> = (model: Model, msg: Msg) => [Model, Effect<Msg>[]];
export type EffectFailed<Msg> = (error: unknown) => Msg;

export interface Program<Model, Msg> {
  getModel(): Model;
  dispatch(msg: Msg): void;
  subscribe(listener: () => void): () => void;
}

export function createProgram<Model, Msg>(init: Model, update: Update<Model, Msg>, effectFailed: EffectFailed<Msg>): Program<Model, Msg> {
  let model = init;
  const listeners = new Set<() => void>();
  const queue: Msg[] = [];
  let processing = false;

  function dispatch(msg: Msg): void {
    queue.push(msg);
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) step(queue.shift() as Msg);
    } finally {
      processing = false;
    }
  }

  function step(msg: Msg): void {
    const [next, effects] = update(model, msg);
    if (!Object.is(next, model)) {
      model = next;
      for (const listener of [...listeners]) listener();
    }
    for (const effect of effects) runEffect(effect);
  }

  function runEffect(effect: Effect<Msg>): void {
    let result: void | Promise<void>;
    try {
      result = effect(dispatch);
    } catch (error) {
      dispatch(effectFailed(error));
      return;
    }
    if (result instanceof Promise) result.catch((error: unknown) => dispatch(effectFailed(error)));
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
