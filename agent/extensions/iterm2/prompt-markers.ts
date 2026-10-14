const PROMPT_START = /\x1b\]133;A(?:\x07|\x1b\\)/g;

/** Observe Pi's prompt markers without changing bytes, callbacks or backpressure. */
export function observePromptMarkers(
    stream: Pick<NodeJS.WriteStream, "write">,
    onPromptStart: () => void,
): () => void {
    const previous = stream.write;
    let observing = true;
    let tail = "";
    const wrapped = function (this: NodeJS.WriteStream, ...args: unknown[]): boolean {
        const result = Reflect.apply(previous, this, args) as boolean;
        if (!observing) return result;
        const chunk = args[0];
        const text = typeof chunk === "string"
            ? typeof args[1] === "string"
                ? Buffer.from(chunk, args[1] as BufferEncoding).toString("latin1")
                : chunk
            : chunk instanceof Uint8Array
                ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("latin1")
                : "";
        const combined = tail + text;
        const pattern = new RegExp(PROMPT_START);
        let end = 0;
        for (const match of combined.matchAll(pattern)) end = match.index + match[0].length;
        // Keep only an incomplete suffix, never a marker already reported. A
        // marker may span stdout chunks, including the two-byte ST terminator.
        tail = combined.slice(end).slice(-8);
        if (end > 0) onPromptStart();
        return result;
    };
    stream.write = wrapped;
    return () => {
        observing = false;
        tail = "";
        // A later owner may have wrapped stdout too. Don't remove its wrapper;
        // our now-inactive link simply forwards to the preceding writer.
        if (stream.write === wrapped) stream.write = previous;
    };
}
