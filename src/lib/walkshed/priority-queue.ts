export class MinDistanceQueue {
  private heap: Array<{ nodeIndex: number; distanceMeters: number }> = [];

  push(value: { nodeIndex: number; distanceMeters: number }): void {
    this.heap.push(value);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): { nodeIndex: number; distanceMeters: number } | null {
    if (this.heap.length === 0) return null;
    const first = this.heap[0];
    const last = this.heap.pop();

    if (last && this.heap.length > 0) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }

    return first;
  }

  get size(): number {
    return this.heap.length;
  }

  private bubbleUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.heap[parent].distanceMeters <= this.heap[i].distanceMeters) break;
      [this.heap[parent], this.heap[i]] = [this.heap[i], this.heap[parent]];
      i = parent;
    }
  }

  private bubbleDown(index: number): void {
    let i = index;
    while (true) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;

      if (
        left < this.heap.length &&
        this.heap[left].distanceMeters < this.heap[smallest].distanceMeters
      ) {
        smallest = left;
      }

      if (
        right < this.heap.length &&
        this.heap[right].distanceMeters < this.heap[smallest].distanceMeters
      ) {
        smallest = right;
      }

      if (smallest === i) break;
      [this.heap[smallest], this.heap[i]] = [this.heap[i], this.heap[smallest]];
      i = smallest;
    }
  }
}
