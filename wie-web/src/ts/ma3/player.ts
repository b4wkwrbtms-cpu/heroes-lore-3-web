import type { Ma3Score } from "./smaf";

/** Receives the General MIDI percussion messages the FM synthesizer cannot render itself. */
export type MidiSink = (data: number[], time: number) => void;

type ProcessorMessage = { type: "midi"; data: number[]; time: number } | { type: "ended"; handle: number };

/** Plays parsed MA-3 scores on the FM synthesizer worklet (public/ma3_processor.js). */
export class Ma3Player {
  private node: AudioWorkletNode | undefined;
  private readonly ready: Promise<boolean>;

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

  /** Plays `score`, starting `offsetMs` into it (used to resume background music after a sound effect). */
  async play(handle: number, score: Ma3Score, repeat: boolean, offsetMs = 0): Promise<boolean> {
    if (!(await this.ready) || !this.node) return false;
    this.node.port.postMessage({ type: "play", handle, score, repeat, offsetMs });
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
