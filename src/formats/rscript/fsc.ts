/** FSC frame-script instructions, in the order of the native byte codes (0x42CE50). */
export type FscInstruction =
  | {readonly op: 'end'}
  | {readonly op: 'frame'; readonly frame: number}
  | {readonly op: 'hold'}
  | {readonly op: 'jump'; readonly target: number}
  | {readonly op: 'if'; readonly variable: number; readonly value: number; readonly target: number}
  | {readonly op: 'random'; readonly range: number; readonly target: number};

function isLeadByte(byte: number): boolean {
  return (byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc);
}

/** sub_4590D0 + sub_459160: non-blank lines, cut at `;`, with whitespace runs as one space. */
function lines(bytes: Uint8Array): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    let line = '',
      started = false,
      space = false;
    for (; i < bytes.length && bytes[i] !== 0x0a; i++) {
      const byte = bytes[i]!;
      if (isLeadByte(byte)) {
        // Double-byte characters are kept byte for byte; their trail never ends a line.
        line += String.fromCharCode(byte, bytes[i + 1] ?? 0);
        i++;
        started = true;
        space = false;
        continue;
      }
      if (byte === 0x0d) continue;
      if (byte === 0x20 || byte === 0x09) {
        if (started && !space) line += ' ';
        space = started;
        continue;
      }
      line += String.fromCharCode(byte);
      started = true;
      space = false;
    }
    i++;
    if (!started) continue;
    const comment = line.indexOf(';');
    result.push(comment < 0 ? line : line.slice(0, comment));
  }
  return result;
}

/** sub_459310: optional spaces and sign, then decimal digits. */
function integer(text: string): number {
  const match = /^[ \t]*(-?)(\d*)/.exec(text)!;
  const value = match[2] ? Number.parseInt(match[2], 10) : 0;
  return match[1] ? -value : value;
}

/**
 * Compiles an FSC frame script (sub_42CE50). Lines start with `:` (label), `.` (hold one
 * tick), `-` (end), `>label` (jump), `?variable value label` or `?rnd range label`
 * (conditional jump); any other line shows the numbered frame. Comment-only lines compile
 * to frame 0 like the native parser. Labels are case-sensitive; unknown ones jump to the
 * start.
 */
export function parseFsc(bytes: Uint8Array): FscInstruction[] {
  const code: FscInstruction[] = [];
  const labels = new Map<string, number>();
  const pending: {index: number; label: string}[] = [];
  const token = (text: string): [string, string] => {
    const space = text.indexOf(' ');
    return space < 0 ? [text, ''] : [text.slice(0, space), text.slice(space + 1).trimStart()];
  };
  for (const line of lines(bytes)) {
    const rest = line.slice(1);
    switch (line[0]) {
      case ':': {
        // std::map::insert keeps the first definition of a label.
        const [name] = token(rest);
        if (!labels.has(name)) labels.set(name, code.length);
        break;
      }
      case '.':
        code.push({op: 'hold'});
        break;
      case '-':
        code.push({op: 'end'});
        break;
      case '>': {
        pending.push({index: code.length, label: token(rest)[0]});
        code.push({op: 'jump', target: 0});
        break;
      }
      case '?': {
        const [name, tail] = token(rest);
        const [value, afterValue] = token(tail);
        const [label] = token(afterValue);
        pending.push({index: code.length, label});
        code.push(
          name.toUpperCase() === 'RND'
            ? {op: 'random', range: integer(value), target: 0}
            : {op: 'if', variable: integer(name) & 0xffff, value: integer(value), target: 0},
        );
        break;
      }
      default:
        code.push({op: 'frame', frame: integer(line) & 0xff});
    }
  }
  for (const {index, label} of pending) {
    const target = labels.get(label) ?? 0;
    code[index] = {...code[index]!, target} as FscInstruction;
  }
  return code;
}
