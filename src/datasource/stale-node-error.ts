export class StaleNodeRequestError extends Error {
  constructor(public readonly key: string) {
    super(`node ${key} belongs to a closed or unknown cloud (the file was closed)`);
    this.name = "StaleNodeRequestError";
  }
}
