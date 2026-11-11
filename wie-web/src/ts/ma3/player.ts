import type { Ma3Score } from "./smaf";

/** Receives the General MIDI percussion messages the FM synthesizer cannot render itself. */
export type MidiSink = (data: number[], time: number) => void;

type ProcessorMessage = { type: "midi"; data: number[]; time: number } | { type: "ended"; handle: number };

/** Plays parsed MA-3 scores on the FM synthesizer worklet (public/ma3_processor.js). */
/** Scores the synthesizer keeps; the least recently played one is dropped beyond this. */
const SENT_SCORE_LIMIT = 128;

export class Ma3Player {
  private node: AudioWorkletNode | undefined;
  private readonly ready: Promise<boolean>;
  /** Keys of the scores the synthesizer holds, least recently played first. */
  private readonly sentScores = new Set<number>();

  constructor(context: AudioContext, destination: AudioNode, midi: MidiSink) {
    this.ready = context.audioWorklet
      .addModule(new URL("ma3_processor.js", document.baseURI).href)
      .then(() => {
        const node = new AudioWorkletNode(context, "ma3-processor", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
        node.port.onmessage = (event: MessageEvent<ProcessorMessage>) => {
          if (event.data.type === "midi") midi(event.data.data, event.data.time);
        };
        node.connect(destination);
        this.node = node;
        return true;
      })
      .catch(error => {
        console.warn("MA-3 FM synthesizer is unavailable:", error);
        return false;
      });
  }

  /**
   * Plays `score` (identified by `key`, its content fingerprint), starting `offsetMs` into it (used to resume
   * background music after a sound effect). The synthesizer keeps the scores it has seen, so a clip the game creates
   * again (every sound effect recreates the background music) is not copied over again.
   */
  async play(handle: number, key: number, score: Ma3Score, repeat: boolean, offsetMs = 0): Promise<boolean> {
    if (!(await this.ready) || !this.node) return false;
    const known = this.sentScores.delete(key);
    this.sentScores.add(key);
    if (!known && this.sentScores.size > SENT_SCORE_LIMIT) {
      const oldest = this.sentScores.values().next().value as number;
      this.sentScores.delete(oldest);
      this.node.port.postMessage({ type: "forget", key: oldest });
    }
    this.node.port.postMessage({ type: "play", handle, key, score: known ? undefined : score, repeat, offsetMs });
    return true;
  }

  async stop(handle: number): Promise<void> {
    if (!(await this.ready) || !this.node) return;
    this.node.port.postMessage({ type: "stop", handle });
  }

  dispose(): void {
    this.node?.port.postMessage({ type: "stopAll" });
    this.node?.disconnect();
    this.node = undefined;
  }
}
