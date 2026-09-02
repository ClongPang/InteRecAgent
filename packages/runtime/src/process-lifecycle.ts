type TerminationSignal = "SIGINT" | "SIGTERM";

interface SignalSource {
  once(event: TerminationSignal, listener: () => void): unknown;
  removeListener(event: TerminationSignal, listener: () => void): unknown;
}

/** Resolves exactly once and removes the losing signal listener so shutdown has one owner. */
export function waitForTerminationSignal(source: SignalSource = process): Promise<TerminationSignal> {
  return new Promise((resolve) => {
    const finish = (signal: TerminationSignal) => {
      source.removeListener("SIGINT", onSigint);
      source.removeListener("SIGTERM", onSigterm);
      resolve(signal);
    };
    const onSigint = () => finish("SIGINT");
    const onSigterm = () => finish("SIGTERM");
    source.once("SIGINT", onSigint);
    source.once("SIGTERM", onSigterm);
  });
}
