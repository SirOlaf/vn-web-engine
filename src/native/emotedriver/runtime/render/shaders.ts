import {sha256Fallback} from '../../../../core/sha256.js';

/**
 * Compiled D3D9 shaders embedded in `emotedriver.dll` (`.data`, pointer tables VS SM2
 * 0x10086754, PS SM2 0x100866e8, VS SM3 0x100867cc, PS SM3 0x10086760). The SM2 set is used
 * at shader level 1, the SM3 set at level 2 (0x100561c0, 0x100562d0). The game file may not
 * ship with the site; without the blobs the device runs at shader level 0 (fixed function),
 * as the native code does on a device without shader support.
 */
export interface EmoteShaderBlobs {
  /** Vertex shaders 0 (plain), 1 (alpha mask), 2 (pixelate). */
  readonly vertexSm2: readonly Uint8Array[];
  readonly vertexSm3: readonly Uint8Array[];
  /** Pixel shaders 0–23 (`variant + 3·mask + 6·colorDouble + 12·alphaOnly`), 24, 25, 26. */
  readonly pixelSm2: readonly Uint8Array[];
  readonly pixelSm3: readonly Uint8Array[];
}

export const EMOTE_VERTEX_SHADER_COUNT = 3;
export const EMOTE_PIXEL_SHADER_COUNT = 27;

/** [file offset, size, SHA-256] in build `a3b693b6…5e70b3a86`. */
type BlobEntry = readonly [number, number, string];

const VS_SM2: readonly BlobEntry[] = [
  [0x813a0, 312, '50f1f480a94dab6cb5fb9a0dd3fe9a78bd5e268e69c7c9d4318a223521bd570d'],
  [0x81010, 432, '683442015a230b0a258f73b754ee356525c6d8a359ed3d30396762e457ef3362'],
  [0x811d0, 448, '32d822ddb7638972af3cd58a2aec74d2396fdaba1dac3d352845ed04e7346f2a'],
];
const PS_SM2: readonly BlobEntry[] = [
  [0x80af0, 224, 'd2021dd076be780ec570a7a6d6529e3ff9a19c4ab7247c4e1bbb873a81ed61f4'],
  [0x808b0, 304, 'f019aebf50eb7f7f93cbd102c5cfce8aa5b464b1731b1a1428330135c9810c9b'],
  [0x809f0, 240, 'c6f3a34e4dc977fffa1a66d1a9a563e56e928ec810280dd744df0caf9fe50ec5'],
  [0x80ec0, 332, '11a351696cbcab565a01c8b0a911006b6c704fdc8fe7f76fe1f16d90b2acc636'],
  [0x80be0, 376, '9be9747c912c7e75829f65de73888c726f70eb8dcb9c4da886a403038fc03d49'],
  [0x80d60, 348, '95f4e39d17b8355d57251044789c8242d2581b0a62633206a00dcb8ca451e3dd'],
  [0x80350, 264, '9a5576dbac1bcc5e74e88ea37b2cb5e487783f4bba080639833f10d2c78abd1b'],
  [0x80100, 304, '545a372fb75c4734eae5e862194419d91300d1747fec7cfc425524bff6e5b669'],
  [0x80240, 256, 'a5dbe7c1ad6809bc3ce152b2ca98e979a959411beb7a9294309f791c2b45da35'],
  [0x80750, 348, '3e9e0531b47d038c612c994cd60ffe89e171d759f36e47b31d566940297edfa1'],
  [0x80460, 376, '41343a93ee60cbf3ca19154fc09e39fee84a00892d0d9bfe0d58797091328ac8'],
  [0x805e0, 364, '1799cbfcb8a67d158a205b99b09442b1f5adf50a09711c7dcee624b73f8c80c9'],
  [0x7fb60, 260, '4ec711fe40683a3525e4e2ec2b07558ade8f734896d04e95999532c487783e7b'],
  [0x7f900, 316, 'e35dc22f82fe29eb4fe9c18dc4deae205afdfd6b96900792a145c46531349348'],
  [0x7fa40, 276, '82ddcb90b3486f32bfcc608a0f335d9cecb51688fc1ace09bddc245ea87826ec'],
  [0x7ff90, 356, 'f5b8aa8de717d301a4a804de6c491f235591ff93f479c960dcfd13fc0a255148'],
  [0x7fc70, 384, '7c050905e2fd5c6a7990652965209e3729cc7aa67c22eebeea6a496d4b9e0dfe'],
  [0x7fe00, 384, 'df0eb8a7dc981a7fed71a4baa0d544b0bba7dd0a42549e53e6e595916baecd33'],
  [0x7f380, 264, 'a15d8d4454782e9b7561d4879edf43ef267e234dfd291c6f7c54205e889bba2f'],
  [0x7f160, 268, '3c28b95efa306a70a1c2912b5def81d9505db64109824ea3cbf393655233ab8d'],
  [0x7f270, 256, 'd6ddfc043002c98b9d02f92fb98532aea6086b274407d71cb64186cf989ed5b6'],
  [0x7f780, 372, 'ee366d91bbecad2d383265d0956cf2a006253776e1a27f215d011b9a6589b0c8'],
  [0x7f490, 376, 'f006966dcf5222892c9eba8e8b574646e813958af8d30de0a34745e54ea1dcd4'],
  [0x7f610, 364, '50c63409c3275a0ab1194a7a1bfb32b417aa7f7d9acb8aacfd571092cae92027'],
  [0x7ee00, 220, '12b24cd2cb4ffbc5022b946fca819adb5eca850f53fd66547821cc35dc7c8ade'],
  [0x7eee0, 304, '3879292c85a3c28270a88c25d0ffe27781dcd118ab9508359508f8f95b85fbf2'],
  [0x7f020, 304, 'c88e4a1c903fa900ad576b3bbc8bbc5bc277be2c90186db8b87e0aff9ad02113'],
];
// VS SM3 #1 and #2 are byte-identical to #0.
const VS_SM3: readonly BlobEntry[] = [
  [0x83da0, 348, '5c6335402a77180c7c91ed056ce9492cffcf1dd5a4596fc668eeb2be6adeba6e'],
  [0x83ae0, 348, '5c6335402a77180c7c91ed056ce9492cffcf1dd5a4596fc668eeb2be6adeba6e'],
  [0x83c40, 348, '5c6335402a77180c7c91ed056ce9492cffcf1dd5a4596fc668eeb2be6adeba6e'],
];
const PS_SM3: readonly BlobEntry[] = [
  [0x834b0, 212, 'bac0184e30d16bed7f49310e95dde021708b28413a03aa7a25b272602ba254f2'],
  [0x832a0, 256, '822f6008e45fc42755fd207f073b7b420ee8cd4283e1fe5cbd56286d38c18c4f'],
  [0x833b0, 240, '7023be78f2136cac2779d2d45ef461a29af4ac8c72349b66208dc83574bbab8e'],
  [0x83920, 432, 'ae612be0731106bdf9a957095fc00c976b23d39afb3fea33ad8297a97d6ee66d'],
  [0x83590, 440, 'b96e94257402a91e234f3d345d0de9a3397762dcd8b2a69ad564845e391f4b0a'],
  [0x83750, 448, 'a2d992f0ac0374d1d5263348e9d96c5b51711fa397af1cbe6e8de1830a94ac40'],
  [0x82c40, 252, 'c95f5c05c8a2193275ce760dffc4771105f45330ede7e43138008492446f0827'],
  [0x82a20, 256, '3966622a165b9dae1561541679b073895efb4339d09d3ebab9c30e1f1576701b'],
  [0x82b30, 256, '9227a8d940f8c0a134e28fd86ac6f8342331194e1c9434fd105a4931a86f2184'],
  [0x830e0, 436, 'c3695725200fe4c7263d76979aaeb6c9e93820051763fc3094a7af995cd794f7'],
  [0x82d40, 440, '3d55841a93deec9a40defa7e20b4d0d2d579a746e679362c9094e5a03ed11c16'],
  [0x82f00, 464, '63780d3b376fb11f81b3a95ca5b0ee6383366257d2bd7af8c43325072464ab1f'],
  [0x823a0, 256, '2a82e5993685595b7e8b772f744552fb9d4b29f0745a0670440e09677e643798'],
  [0x82160, 276, 'd9d46f92ae7a6f4c1d9520f70c3a98c747b5b15726c98241d86827db89e258b5'],
  [0x82280, 284, '9417111687e2646c1304f227d7a9928b14b365c5dc22b125d8f193e7fd23ce84'],
  [0x82860, 444, '39f1b38bf5ac6deca20734612508e0a9c2bd9575013efd536648666b7f26a7fb'],
  [0x824b0, 460, '21091466569f4fb1ef2eb6cb76be2191a3bc803076398b5d113400c8f53d9c2f'],
  [0x82680, 468, 'd2592bab9779969c66f97cb3e1e64f25228abae5264063e6548bc58d727667fc'],
  [0x81b10, 228, '49bb89ae14b566f6518547773d507c10562ca3d27b5cff81f23079cca3d72450'],
  [0x818f0, 256, '42923680e517a5f1516158ca393b70aa0ea1bb9d09fbbd7aaa7d86b5c2fec8a4'],
  [0x81a00, 256, '95d2d8881fc0eacc1d6b585578099be4be00ec9dd3c1156ce91953c139db4f6a'],
  [0x81fa0, 436, 'e6807c23c1edff24daf96ec85c321401f4e2bb128320a6c63332bf74a1f63aed'],
  [0x81c00, 440, 'ef86bed0f29ca7d2d98b123327dd6f59ff10b8e34221b693779aa6268c5a2bb5'],
  [0x81dc0, 464, '6c4f7f4298183f9df66977955339b853e4272a92731c28fd484986aed30b5385'],
  [0x814e0, 196, '373920d79c27b2d21b6330a4d5a69730a8d879d78bdbbe5a993238f3de60d1ab'],
  [0x815b0, 404, '2de01a5f57dbc6f68a4d86721a138eea7887a997762b5a713c0aba9f86ef8c81'],
  [0x81750, 404, '72912ee718e819ea2d2456319048ce1883e505ffd705494e8d5e07b509cc32cd'],
];

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function extract(file: Uint8Array, table: readonly BlobEntry[]): Uint8Array[] | null {
  const out: Uint8Array[] = [];
  for (const [offset, size, digest] of table) {
    if (offset + size > file.length) return null;
    const blob = file.slice(offset, offset + size);
    if (hex(sha256Fallback(blob)) !== digest) return null;
    out.push(blob);
  }
  return out;
}

/**
 * Extracts the 60 shader blobs from an `emotedriver.dll` file image by their file offsets,
 * verifying each SHA-256. Returns null when any blob is missing or differs.
 */
export function extractEmoteShaderBlobs(file: Uint8Array): EmoteShaderBlobs | null {
  const vertexSm2 = extract(file, VS_SM2),
    pixelSm2 = extract(file, PS_SM2),
    vertexSm3 = extract(file, VS_SM3),
    pixelSm3 = extract(file, PS_SM3);
  if (vertexSm2 === null || pixelSm2 === null || vertexSm3 === null || pixelSm3 === null)
    return null;
  return {vertexSm2, pixelSm2, vertexSm3, pixelSm3};
}
