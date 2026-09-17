/** De-duplicates stream events by sequence number (events may arrive twice after a reconnect + replay). */
export function createOutputTracker(startSeq = 0) {
  let lastSeq = startSeq;
  return {
    get lastSeq() {
      return lastSeq;
    },
    accept(event: { seq: number }): boolean {
      if (event.seq <= lastSeq) return false;
      lastSeq = event.seq;
      return true;
    },
    reset(seq: number) {
      lastSeq = seq;
    },
  };
}
