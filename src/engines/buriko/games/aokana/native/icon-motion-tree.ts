/** 005A10/005D50/002200: signed-DWORD std::map tree used by DCIPIconEEx. */
class MotionNode<T> {
  left: MotionNode<T> = this;
  right: MotionNode<T> = this;
  parent: MotionNode<T> = this;
  black = false;
  constructor(
    readonly key: number,
    readonly value: T | undefined,
    readonly sentinel = false,
  ) {}
}
export class AokanaIconMotionTree<T> {
  private readonly head = new MotionNode<T>(0, undefined, true);
  constructor() {
    this.head.black = true;
  }
  private get root(): MotionNode<T> {
    return this.head.parent;
  }
  private set root(value: MotionNode<T>) {
    this.head.parent = value;
  }
  private minimum(node: MotionNode<T>): MotionNode<T> {
    while (!node.left.sentinel) node = node.left;
    return node;
  }
  private maximum(node: MotionNode<T>): MotionNode<T> {
    while (!node.right.sentinel) node = node.right;
    return node;
  }
  private findNode(key: number): MotionNode<T> {
    key |= 0;
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
  find(key: number): T | undefined {
    return this.findNode(key).value;
  }
  private rotateLeft(node: MotionNode<T>): void {
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
  private rotateRight(node: MotionNode<T>): void {
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
  /** Caller removes any previous key, including its owned spline, before insertion. */
  insert(key: number, value: T): void {
    key |= 0;
    let parent = this.head,
      current = this.root;
    while (!current.sentinel) {
      parent = current;
      current = key < current.key ? current.left : current.right;
    }
    const node = new MotionNode(key, value);
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
  /** Native erase transplants the successor node, rather than copying its payload. */
  remove(key: number, dispose: (value: T) => void): boolean {
    const node = this.findNode(key);
    if (node.sentinel) return false;
    let replacement: MotionNode<T>,
      parent: MotionNode<T>,
      removedBlack = node.black;
    if (!node.left.sentinel && !node.right.sentinel) {
      const successor = this.minimum(node.right);
      replacement = successor.right;
      node.left.parent = successor;
      successor.left = node.left;
      if (successor === node.right) parent = successor;
      else {
        parent = successor.parent;
        if (!replacement.sentinel) replacement.parent = parent;
        parent.left = replacement;
        successor.right = node.right;
        node.right.parent = successor;
      }
      if (node === this.root) this.root = successor;
      else if (node === node.parent.left) node.parent.left = successor;
      else node.parent.right = successor;
      successor.parent = node.parent;
      removedBlack = successor.black;
      successor.black = node.black;
    } else {
      replacement = node.left.sentinel ? node.right : node.left;
      parent = node.parent;
      if (!replacement.sentinel) replacement.parent = parent;
      if (node === this.root) this.root = replacement;
      else if (node === parent.left) parent.left = replacement;
      else parent.right = replacement;
      if (node === this.head.left)
        this.head.left = replacement.sentinel ? parent : this.minimum(replacement);
      if (node === this.head.right)
        this.head.right = replacement.sentinel ? parent : this.maximum(replacement);
    }
    if (removedBlack) {
      let x = replacement,
        p = parent;
      while (x !== this.root && x.black) {
        if (x === p.left) {
          let sibling = p.right;
          if (!sibling.black) {
            sibling.black = true;
            p.black = false;
            this.rotateLeft(p);
            sibling = p.right;
          }
          if (!sibling.sentinel) {
            if (sibling.left.black && sibling.right.black) sibling.black = false;
            else {
              if (sibling.right.black) {
                sibling.left.black = true;
                sibling.black = false;
                this.rotateRight(sibling);
                sibling = p.right;
              }
              sibling.black = p.black;
              p.black = true;
              sibling.right.black = true;
              this.rotateLeft(p);
              break;
            }
          }
        } else {
          let sibling = p.left;
          if (!sibling.black) {
            sibling.black = true;
            p.black = false;
            this.rotateRight(p);
            sibling = p.left;
          }
          if (!sibling.sentinel) {
            if (sibling.right.black && sibling.left.black) sibling.black = false;
            else {
              if (sibling.left.black) {
                sibling.right.black = true;
                sibling.black = false;
                this.rotateLeft(sibling);
                sibling = p.left;
              }
              sibling.black = p.black;
              p.black = true;
              sibling.left.black = true;
              this.rotateRight(p);
              break;
            }
          }
        }
        x = p;
        p = p.parent;
      }
      x.black = true;
    }
    dispose(node.value!);
    return true;
  }
  *values(): IterableIterator<T> {
    let node = this.head.left;
    while (node !== this.head) {
      yield node.value!;
      if (!node.right.sentinel) node = this.minimum(node.right);
      else {
        let parent = node.parent;
        while (!parent.sentinel && node === parent.right) {
          node = parent;
          parent = parent.parent;
        }
        node = parent;
      }
    }
  }
  /** 005A50 traverses right subtree, destroys current payload, then its left subtree. */
  clear(dispose: (value: T) => void): void {
    const visit = (node: MotionNode<T>): void => {
      while (!node.sentinel) {
        visit(node.right);
        const left = node.left;
        dispose(node.value!);
        node = left;
      }
    };
    visit(this.root);
    this.head.left = this.head.right = this.head.parent = this.head;
  }
}
