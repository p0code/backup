/** Bytes arriving in arbitrary pieces, taken off the front in exact sizes without re-copying the rest. */
export class BufferQueue {
  private pieces: Array<Buffer> = [];
  length = 0;

  push(piece: Buffer): void {
    if (piece.length === 0) return;
    this.pieces.push(piece);
    this.length += piece.length;
  }

  /** Removes and returns the first `size` bytes; callers check `length` first. */
  take(size: number): Buffer {
    if (size > this.length) throw new RangeError(`Asked for ${size} bytes, have ${this.length}.`);
    const out = Buffer.allocUnsafe(size);
    let filled = 0;
    while (filled < size) {
      const piece = this.pieces[0]!;
      const used = Math.min(piece.length, size - filled);
      piece.copy(out, filled, 0, used);
      filled += used;
      if (used === piece.length) this.pieces.shift();
      else this.pieces[0] = piece.subarray(used);
    }
    this.length -= size;
    return out;
  }
}
