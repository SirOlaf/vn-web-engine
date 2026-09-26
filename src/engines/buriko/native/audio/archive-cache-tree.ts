/** 00E870/00EAC0: audio cache red/black tree, unsigned UTF-16 lexicographic keys. */
class ArchiveNode<T> {
  left: ArchiveNode<T> = this;
  right: ArchiveNode<T> = this;
  parent: ArchiveNode<T> = this;
  black = false;
  constructor(
    readonly key: string,
    public value: T | undefined,
    readonly sentinel = false,
  ) {}
}
export class BurikoAudioArchiveTree<T> {
  private readonly head = new ArchiveNode<T>('', undefined, true);
  private count = 0n;
  constructor() {
    this.head.black = true;
  }
  private get root(): ArchiveNode<T> {
    return this.head.parent;
  }
  private set root(value: ArchiveNode<T>) {
    this.head.parent = value;
  }
  private findNode(key: string): ArchiveNode<T> {
    let node = this.root,
      candidate = this.head;
    while (!node.sentinel) {
      if (node.key < key) node = node.right;
      else {
        candidate = node;
        node = node.left;
      }
    }
    return candidate.sentinel || key < candidate.key ? this.head : candidate;
  }
  find(key: string): T | undefined {
    return this.findNode(key).value;
  }
  private rotateLeft(node: ArchiveNode<T>): void {
    const child = node.right;
    node.right = child.left;
    if (!child.left.sentinel) child.left.parent = node;
    child.parent = node.parent;
    if (node === this.root) this.root = child;
    else if (node === node.parent.left) node.parent.left = child;
    else node.parent.right = child;
    child.left = node;
    node.parent = child;
  }
  private rotateRight(node: ArchiveNode<T>): void {
    const child = node.left;
    node.left = child.right;
    if (!child.right.sentinel) child.right.parent = node;
    child.parent = node.parent;
    if (node === this.root) this.root = child;
    else if (node === node.parent.right) node.parent.right = child;
    else node.parent.left = child;
    child.right = node;
    node.parent = child;
  }
  /** 1124B0 publishes replacement before destroying the previous owned archive. */
  replace(key: string, value: T, dispose: (value: T) => void): boolean {
    const node = this.findNode(key);
    if (node.sentinel) return false;
    const previous = node.value!;
    node.value = value;
    dispose(previous);
    return true;
  }
  /** 00EAC0 duplicate fallback destroys candidate without changing the existing node. */
  insertOrKeep(key: string, value: T, dispose: (value: T) => void): T {
    const existing = this.findNode(key);
    if (!existing.sentinel) {
      dispose(value);
      return existing.value!;
    }
    this.insert(key, value);
    return value;
  }
  private insert(key: string, value: T): void {
    if (this.count > 0x38e38e38e38e38cn)
      throw new RangeError('Buriko audio archive map/set<T> too long');
    this.count++;
    let parent = this.head,
      current = this.root;
    while (!current.sentinel) {
      parent = current;
      current = key < current.key ? current.left : current.right;
    }
    const node = new ArchiveNode(key, value);
    node.left = node.right = this.head;
    node.parent = parent;
    if (parent.sentinel) {
      this.root = node;
      this.head.left = this.head.right = node;
    } else if (key < parent.key) {
      parent.left = node;
      if (parent === this.head.left) this.head.left = node;
    } else {
      parent.right = node;
      if (parent === this.head.right) this.head.right = node;
    }
    let n = node;
    while (!n.parent.black) {
      if (n.parent === n.parent.parent.left) {
        const uncle = n.parent.parent.right;
        if (!uncle.black) {
          n.parent.black = true;
          uncle.black = true;
          n.parent.parent.black = false;
          n = n.parent.parent;
        } else {
          if (n === n.parent.right) {
            n = n.parent;
            this.rotateLeft(n);
          }
          n.parent.black = true;
          n.parent.parent.black = false;
          this.rotateRight(n.parent.parent);
        }
      } else {
        const uncle = n.parent.parent.left;
        if (!uncle.black) {
          n.parent.black = true;
          uncle.black = true;
          n.parent.parent.black = false;
          n = n.parent.parent;
        } else {
          if (n === n.parent.left) {
            n = n.parent;
            this.rotateRight(n);
          }
          n.parent.black = true;
          n.parent.parent.black = false;
          this.rotateLeft(n.parent.parent);
        }
      }
    }
    this.root.black = true;
  }
  /** 00DA30 clears right subtree, current owned archive, then left subtree. */
  clear(dispose: (value: T) => void): void {
    const visit = (node: ArchiveNode<T>): void => {
      while (!node.sentinel) {
        visit(node.right);
        const left = node.left;
        dispose(node.value!);
        node = left;
      }
    };
    visit(this.root);
    this.head.left = this.head.right = this.head.parent = this.head;
    this.count = 0n;
  }
}
