/**
 * Tracks the ids of reply events the middleman has published, each with the
 * unix time it becomes due for deletion (its NIP-40 expiration). `takeDue`
 * drains the due ids so the caller can publish a NIP-09 deletion for them.
 *
 * NIP-40 expiration is advisory — many relays ignore it — so we also issue an
 * explicit NIP-09 `kind 5` delete to actively remove our own events.
 */
export interface PendingDeletion {
  id: string;
  deleteAt: number;
}

export class DeletionQueue {
  private items: PendingDeletion[] = [];

  add(id: string, deleteAt: number): void {
    this.items.push({ id, deleteAt });
  }

  /** Remove and return the ids whose `deleteAt <= now`; keep the rest queued. */
  takeDue(now: number): string[] {
    const due: string[] = [];
    const keep: PendingDeletion[] = [];
    for (const item of this.items) {
      if (item.deleteAt <= now) due.push(item.id);
      else keep.push(item);
    }
    this.items = keep;
    return due;
  }
}
