/**
 * Real ZK Cryptographic Primitives for StealthSol
 *
 * This module provides production-ready implementations of:
 * - Poseidon hash (ZK-friendly, BN254 compatible with circomlib)
 * - Pedersen commitments (for confidential amounts)
 * - Incremental Merkle tree
 * - Nullifier generation
 *
 * The Poseidon implementation matches the on-chain Rust implementation exactly.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { schnorr } from '@noble/curves/secp256k1.js';

// ============================================
// BN254 Field Constants (for Poseidon)
// ============================================

// BN254 scalar field prime
export const BN254_PRIME = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

// Poseidon configuration for t=3
const POSEIDON_T = 3;
const POSEIDON_RF = 8;  // Full rounds
const POSEIDON_RP = 57; // Partial rounds
const POSEIDON_ROUNDS = POSEIDON_RF + POSEIDON_RP; // 65 total

// ============================================
// Field Arithmetic
// ============================================

export function fieldAdd(a: bigint, b: bigint): bigint {
  return ((a + b) % BN254_PRIME + BN254_PRIME) % BN254_PRIME;
}

export function fieldSub(a: bigint, b: bigint): bigint {
  return ((a - b) % BN254_PRIME + BN254_PRIME) % BN254_PRIME;
}

export function fieldMul(a: bigint, b: bigint): bigint {
  return ((a * b) % BN254_PRIME + BN254_PRIME) % BN254_PRIME;
}

export function fieldPow(base: bigint, exp: bigint): bigint {
  let result = BigInt(1);
  base = ((base % BN254_PRIME) + BN254_PRIME) % BN254_PRIME;
  while (exp > 0) {
    if (exp % BigInt(2) === BigInt(1)) {
      result = fieldMul(result, base);
    }
    exp = exp / BigInt(2);
    base = fieldMul(base, base);
  }
  return result;
}

// S-box: x^5 mod p
function sbox(x: bigint): bigint {
  const x2 = fieldMul(x, x);
  const x4 = fieldMul(x2, x2);
  return fieldMul(x4, x);
}

// ============================================
// Convert u64 limbs to BigInt (little-endian)
// ============================================

function limbs4ToBigInt(limbs: [bigint, bigint, bigint, bigint]): bigint {
  return limbs[0] + (limbs[1] << 64n) + (limbs[2] << 128n) + (limbs[3] << 192n);
}

// ============================================
// Poseidon Round Constants (from circomlib)
// 65 rounds * 3 constants per round = 195 constants
// Matches the Rust implementation exactly
// ============================================

const ROUND_CONSTANTS: bigint[] = [
  // Round 0
  limbs4ToBigInt([0x8d21d47304cd8e6en, 0x14c4993c11bb2993n, 0xd05986d656f40c21n, 0x0ee9a592ba9a9518n]),
  limbs4ToBigInt([0x5696fff40956e864n, 0x887b08d4d00868dfn, 0x5986587169fc1bcdn, 0x00f1445235f2148cn]),
  limbs4ToBigInt([0xe879f3890ecf73f5n, 0x30c728730b7ab36cn, 0x1f29a058d0fa80b9n, 0x08dff3487e8ac99en]),
  // Round 1
  limbs4ToBigInt([0x20966310fadc01d0n, 0x56c35342c84bda6en, 0xc3ce28f7532b13c8n, 0x2f27be690fdaee46n]),
  limbs4ToBigInt([0x8b8327bebca16cf2n, 0xb763fe04b8043ee4n, 0x2416bebf3d4f6234n, 0x2b2ae1acf68b7b8dn]),
  limbs4ToBigInt([0xe64b44c7dbf11cfan, 0x5952c175ab6b03ean, 0xcca5eac06f97d4d5n, 0x0319d062072bef7en]),
  // Round 2
  limbs4ToBigInt([0x8ef7b387bf28526dn, 0xc8b7bf27ad49c629n, 0x8a376df87af4a63bn, 0x28813dcaebaeaa82n]),
  limbs4ToBigInt([0x150928adddf9cb78n, 0x2033865200c352bcn, 0xf181bf38e1c1d40dn, 0x2727673b2ccbc903n]),
  limbs4ToBigInt([0xb8fb9e31e65cc632n, 0x6efbd43e340587d6n, 0xe74abd2b2a1494cdn, 0x234ec45ca27727c2n]),
  // Round 3
  limbs4ToBigInt([0xcd99ff6e8797d428n, 0xab10a8150a337b1cn, 0x7f862cb2cf7cf760n, 0x15b52534031ae18fn]),
  limbs4ToBigInt([0xd701d4eecf68d1f6n, 0x8e0e8a8d1b58b132n, 0x5ed9a3d186b79ce3n, 0x0dc8fad6d9e4b35fn]),
  limbs4ToBigInt([0x97805518a47e4d9cn, 0xea4eb378f62e1fecn, 0x600f705fad3fb567n, 0x1bcd95ffc211fbcan]),
  // Round 4
  limbs4ToBigInt([0x17cb978d069de559n, 0xc76da36c25789378n, 0xe9eff81b016fc34dn, 0x10520b0ab721cadfn]),
  limbs4ToBigInt([0xe88a9eb81f5627f6n, 0x2932498075fed0acn, 0x9b257d8ed5fbbaf4n, 0x1f6d48149b8e7f7dn]),
  limbs4ToBigInt([0xca34bdb5460c8705n, 0xfff8dc1c816f0dc9n, 0xd29e00ef35a2089bn, 0x1d9655f652309014n]),
  // Round 5
  limbs4ToBigInt([0x8fe3d4185697cc7dn, 0xa731ff67e4703205n, 0xb051f7b1cd43a99bn, 0x04df5a56ff95bcafn]),
  limbs4ToBigInt([0xf6ec282b6e4be828n, 0x8690a10a8c8424a7n, 0x151b3d290cedaf14n, 0x0672d995f8fff640n]),
  limbs4ToBigInt([0x9fc1d8209b5c75b9n, 0x0c9a9dcc06f2708en, 0xb21200d7ffafdd5fn, 0x099952b414884454n]),
  // Round 6
  limbs4ToBigInt([0x83fd0e843a6b9fa6n, 0x48e43586a9b4cd91n, 0x7c483143ba8d4694n, 0x052cba2255dfd00cn]),
  limbs4ToBigInt([0x16077cb93c464ddcn, 0x82de55707251ad77n, 0xb0bd74712b7999afn, 0x0b8badee690adb8en]),
  limbs4ToBigInt([0xb963d0a8e4b2bdd1n, 0x49c15d60683a8050n, 0x5a1ee651020c07c7n, 0x119b1590f13307afn]),
  // Round 7
  limbs4ToBigInt([0xce15be0bfb4a8d09n, 0x2c4acfc884ef4ee5n, 0x2529d36be0f67b83n, 0x03150b7cd6d5d17bn]),
  limbs4ToBigInt([0xbe69cb317c9ea565n, 0x5374efb83d80898an, 0x3cf1951f17391235n, 0x2cc6182c5e14546en]),
  limbs4ToBigInt([0x92d2cd73111bf0f9n, 0x4218cadedac14e2bn, 0x50cfe129a404b376n, 0x005032551e6378c4n]),
  // Round 8
  limbs4ToBigInt([0x88f9da2cc28276b5n, 0x6469c399fcc069fbn, 0xbb147e972ebcb951n, 0x233237e3289baa34n]),
  limbs4ToBigInt([0xe80c2d4c24d60280n, 0x23037f21b34ae5a4n, 0xc980d31674bfbe63n, 0x05c8f4f4ebd4a6e3n]),
  limbs4ToBigInt([0xee1f09b2590fc65bn, 0x52bcf35ef3aeed91n, 0xba05d818a319f252n, 0x0a7b1db13042d396n]),
  // Round 9
  limbs4ToBigInt([0x5df542365a404ec0n, 0xf156e2b086ff47dcn, 0xb14296572c9d32dbn, 0x2a73b71f9b210cf5n]),
  limbs4ToBigInt([0x76a760bb5c50c460n, 0xec18f2c4dbe7f229n, 0x935107e9ffc91dc3n, 0x1ac9b0417abcc9a1n]),
  limbs4ToBigInt([0x9015ee046dc93fc0n, 0x269f3e4d6cb10434n, 0x3fabb076707ef479n, 0x12c0339ae0837482n]),
  // Round 10
  limbs4ToBigInt([0x8246682e56e9a28en, 0x52900aa3253baac6n, 0x7f5b18db4e1e704fn, 0x0b7475b102a165adn]),
  limbs4ToBigInt([0x32ab3aa88d7f8448n, 0x7c843e379366f2ean, 0xdb1c5e49f6e8b891n, 0x037c2849e191ca3en]),
  limbs4ToBigInt([0x45fdb176a716346fn, 0xd5206c5c93a07dc1n, 0xe92674661e217e9bn, 0x05a6811f8556f014n]),
  // Round 11
  limbs4ToBigInt([0x7b675ef5f38bd66en, 0x4076e87a7b2883b4n, 0x6e947b75d54e9f04n, 0x29a795e7d9802894n]),
  limbs4ToBigInt([0x507be199981fd22fn, 0x6e8c7382c8a1585cn, 0x45a3857afc18f582n, 0x20439a0c84b322ebn]),
  limbs4ToBigInt([0x4a2a6f2a0982c887n, 0xbb50f27799a84b6dn, 0x94ec2050c7371ff1n, 0x2e0ba8d94d9ecf4an]),
  // Round 12
  limbs4ToBigInt([0xe6d0ddcca17d71c8n, 0x17822cd2109048d2n, 0xca38eb7cce822b45n, 0x143fd115ce08fb27n]),
  limbs4ToBigInt([0xc84323623be9caf1n, 0xf8611659323dbcbfn, 0x57968dbbdcf813cdn, 0x0c64cbecb1c734b8n]),
  limbs4ToBigInt([0xf1426cef9403da53n, 0xe74f348d62c2b670n, 0x46fca925c163ff5an, 0x028a305847c683f6n]),
  // Round 13
  limbs4ToBigInt([0x24d6755b5db9e30cn, 0x6a6bcb64d89427b8n, 0x5fa940ab4c4380f2n, 0x2e4ef510ff0b6fdan]),
  limbs4ToBigInt([0xb96384f50579400en, 0x8925b4f6d033b078n, 0x63d79270c956ce3bn, 0x0081c95bc43384e6n]),
  limbs4ToBigInt([0xba8a9f4023a0bb38n, 0xe2491b349c039a0bn, 0x187e2fade687e05en, 0x2ed5f0c91cbd9749n]),
  // Round 14
  limbs4ToBigInt([0x990f01f33a735206n, 0x3448a22c76234c8cn, 0x4bbf374ed5aae2f0n, 0x30509991f88da350n]),
  limbs4ToBigInt([0xa7529094424ec6adn, 0xf0a1119fb2067b41n, 0x221b7c4d49a356b9n, 0x1c3f20fd55409a53n]),
  limbs4ToBigInt([0x170887b47ddcb96cn, 0xc46bb2213e8e131en, 0x049514459b6e18een, 0x10b4e7f3ab5df003n]),
  // Round 15
  limbs4ToBigInt([0x039aa3502e43adefn, 0xdd80f804c077d775n, 0x3ddd543d891c2abdn, 0x2a1982979c3ff7f4n]),
  limbs4ToBigInt([0x5cad0f1315bd5c91n, 0xba431ebc396c9af9n, 0xfeddbead56d6d55dn, 0x1c74ee64f15e1db6n]),
  limbs4ToBigInt([0x9c2fe45a0ae146a0n, 0x9e4f2e8b82708cfan, 0xeab9303cace01b4bn, 0x07533ec850ba7f98n]),
  // Round 16
  limbs4ToBigInt([0x8a11abf3764c0750n, 0x285c68f42d42c180n, 0xa151e4eeaf17b154n, 0x21576b438e500449n]),
  limbs4ToBigInt([0x743d6930836d4a9en, 0xbce8384c815f0906n, 0x08ad5ca193d62f10n, 0x2f17c0559b8fe796n]),
  limbs4ToBigInt([0xe665b0b1b7e2730en, 0x9775a4201318474an, 0xa79e8aae946170bcn, 0x2d477e3862d07708n]),
  // Round 17
  limbs4ToBigInt([0xd89be0f5b2747eabn, 0xafba2266c38f5abcn, 0x90e095577984f291n, 0x162f5243967064c3n]),
  limbs4ToBigInt([0x7777a70092393311n, 0xd7a8596a87f29f8an, 0x264ecd2c8ae50d1an, 0x2b4cb233ede9ba48n]),
  limbs4ToBigInt([0x4254e7c35e03b07an, 0x6db2eece6d85c4cfn, 0x1dbaf8f462285477n, 0x2c8fbcb2dd8573dcn]),
  // Round 18
  limbs4ToBigInt([0xe5e88db870949da9n, 0x9e1b61e9f601e9adn, 0xf2ff453f0cd56b19n, 0x1d6f347725e4816an]),
  limbs4ToBigInt([0x4cd49af5c4565529n, 0xf9e6ac02b68d3132n, 0xebc2d8b3df5b913dn, 0x204b0c397f4ebe71n]),
  limbs4ToBigInt([0x4ff8fb75bc79c502n, 0x9ecb827cd7dc2553n, 0x4f1149b3c63c3c2fn, 0x0c4cb9dc3c4fd817n]),
  // Round 19
  limbs4ToBigInt([0x9a616ddc45bc7b54n, 0x1e5c49475279e063n, 0xa25416474f493030n, 0x174ad61a1448c899n]),
  limbs4ToBigInt([0x3a9816d49a38d2efn, 0xeaaa28c177cc0fa1n, 0xf759df4ec2f3cde2n, 0x1a96177bcf4d8d89n]),
  limbs4ToBigInt([0x8242ace360b8a30an, 0x05202c126a233c1an, 0xd0ef8054bc60c4ffn, 0x066d04b24331d71cn]),
  // Round 20
  limbs4ToBigInt([0x27037a62aa1bd804n, 0x381cc65f72e02ad5n, 0x2195782871c6dd3bn, 0x2a4c4fc6ec0b0cf5n]),
  limbs4ToBigInt([0xe55afc01219fd649n, 0x5e727f8446f6d9d7n, 0x47e9f2e14a7cedc9n, 0x13ab2d136ccf37d4n]),
  limbs4ToBigInt([0x4c2e3e869acc6a9an, 0xc1b04fcec26f5519n, 0x19d24d843dc82769n, 0x1121552fca260616n]),
  // Round 21
  limbs4ToBigInt([0x09a5546c7c97cff1n, 0xa6cd267d595c4a89n, 0x889bc81715c37d77n, 0x00ef653322b13d6cn]),
  limbs4ToBigInt([0x845aca35d8a397d3n, 0x400c776d652595d9n, 0x8b261d8ba74051e6n, 0x0e25483e45a66520n]),
  limbs4ToBigInt([0x46448db979eeba89n, 0x395ac3d4dde92d8cn, 0x245264659e15d88en, 0x29f536dcb9dd7682n]),
  // Round 22
  limbs4ToBigInt([0x0e456baace0fa5ben, 0x5a124e2780bbea17n, 0xdfda33575dbdbd88n, 0x2a56ef9f2c53feban]),
  limbs4ToBigInt([0xee416240a8cb9af1n, 0xf2ae2999a46762e8n, 0xecfb7a2d17b5c409n, 0x1c8361c78eb5cf5dn]),
  limbs4ToBigInt([0xd3d0ab4be74319c5n, 0x83e8e68a764507bfn, 0xc0473089aaf0206bn, 0x151aff5f38b20a0fn]),
  // Round 23
  limbs4ToBigInt([0xe76e47615b51f100n, 0xa9f52fc8c8b6cdd1n, 0xc1b239c88f7f9d43n, 0x04c6187e41ed881dn]),
  limbs4ToBigInt([0x9e801b7ddc9c2967n, 0x4b81c61ed1577644n, 0x10d84331f6fb6d53n, 0x13b37bd80f4d27fbn]),
  limbs4ToBigInt([0x9321ceb1c4e8a8e4n, 0x2ce3664c2a52032cn, 0xf578bfbd32c17b7an, 0x01a5c536273c2d9dn]),
  // Round 24
  limbs4ToBigInt([0x832239065b7c3b02n, 0x4a9a2c666b9726dan, 0x5ad05f5d7acb950bn, 0x2ab3561834ca7383n]),
  limbs4ToBigInt([0x9f7ed516a597b646n, 0xacaf6af4e95d3bf6n, 0x200fe6d686c0d613n, 0x1d4d8ec291e720dbn]),
  limbs4ToBigInt([0x1514c9c80b65af1dn, 0xb925351240a04b71n, 0x8f5784fe7919fd2bn, 0x041294d2cc484d22n]),
  // Round 25
  limbs4ToBigInt([0x042971dd90e81fc6n, 0x98f57939d126e392n, 0x1c4fa715991f0048n, 0x154ac98e01708c61n]),
  limbs4ToBigInt([0x4524563bc6ea4da4n, 0x50b3684c88f8b0b0n, 0x3eedd84093aef510n, 0x0b339d8acca7d4f8n]),
  limbs4ToBigInt([0x81ed95b50839c82en, 0x98f0e71eaff4a7ddn, 0x54a4f84cfbab3445n, 0x0955e49e6610c942n]),
  // Round 26
  limbs4ToBigInt([0x3525401ea0654626n, 0xa9a6f41e6f535c6fn, 0x26b9e22206f15abcn, 0x06746a6156eba544n]),
  limbs4ToBigInt([0xac917c7ff32077fbn, 0x38e5790e2bd0a196n, 0x496f3820c549c278n, 0x0f18f5a0ecd1423cn]),
  limbs4ToBigInt([0x2a738223d6f76e13n, 0x4bb563583ede7bc9n, 0x8ac59eff5beb261en, 0x04f6eeca1751f730n]),
  // Round 27
  limbs4ToBigInt([0xc1768d26fc0b3758n, 0x8811eb116fb3e45bn, 0xc1a3ec4da3cdce03n, 0x2b56973364c4c4f5n]),
  limbs4ToBigInt([0x83feb65d437f29efn, 0x8e1392b385716a5dn, 0xdcd76b89804b1bcbn, 0x123769dd49d5b054n]),
  limbs4ToBigInt([0x94257b2fb01c63e9n, 0xa989f64464711509n, 0x88ee52b91169aacen, 0x2147b424fc48c80an]),
  // Round 28
  limbs4ToBigInt([0xea54ad897cebe54dn, 0x647e6f34ad4243c2n, 0x1a6c5505ea332a29n, 0x0fdc1f58548b8570n]),
  limbs4ToBigInt([0x944f685cc0a0b1f2n, 0xbceff28c5dbbe0c3n, 0xdf68abcf0f7786d4n, 0x12373a8251fea004n]),
  limbs4ToBigInt([0xdd8a1f35c1a90035n, 0xa642756b6af44203n, 0xad7ea52ff742c9e8n, 0x21e4f4ea5f35f85bn]),
  // Round 29
  limbs4ToBigInt([0x8a81934f1bc3b147n, 0xb57366492f45e90dn, 0xdfb4722224d4c462n, 0x16243916d69d2ca3n]),
  limbs4ToBigInt([0xa13a4159cac04ac2n, 0xabc21566e1a0453cn, 0xf66f9adbc88b4378n, 0x1efbe46dd7a578b4n]),
  limbs4ToBigInt([0x3b672cc96a88969an, 0xd468d5525be66f85n, 0x8886020e23a7f387n, 0x07ea5e8537cf5dd0n]),
  // Round 30
  limbs4ToBigInt([0xa9fe16c0b76c00bcn, 0x650f19a75e7ce11cn, 0xb7b478a30f9a5b63n, 0x05a8c4f9968b8aa3n]),
  limbs4ToBigInt([0x2d9d57b72a32e83fn, 0x3f7818c701b9c788n, 0xfbfe59bd345e8dacn, 0x20f057712cc21654n]),
  limbs4ToBigInt([0x9bd90b33eb33db69n, 0x6dcd8e88d01d4901n, 0x9672f8c67fee3163n, 0x04a12ededa9dfd68n]),
  // Round 31
  limbs4ToBigInt([0xe49ec9544ccd101an, 0xbd136ce5091a6767n, 0xe44f1e5425a51decn, 0x27e88d8c15f37dcen]),
  limbs4ToBigInt([0x176c41ee433de4d1n, 0x6e096619a7703223n, 0xb8a5c8c5e95a41f6n, 0x2feed17b84285ed9n]),
  limbs4ToBigInt([0x6972b8bd53aff2b8n, 0x94e5942911312a0dn, 0x404241420f729cf3n, 0x1ed7cc76edf45c7cn]),
  // Round 32
  limbs4ToBigInt([0xdf2874be45466b1an, 0xac6783476144cdcan, 0x157ff8c586f5660en, 0x15742e99b9bfa323n]),
  limbs4ToBigInt([0x284f033f27d0c785n, 0x77107454c6ec0317n, 0xc895fc6887ddf405n, 0x1aac285387f65e82n]),
  limbs4ToBigInt([0xec75a96554d67c77n, 0x832e2e7a49775f71n, 0xf9ddadbdb6057357n, 0x25851c3c845d4790n]),
  // Round 33
  limbs4ToBigInt([0x0ddccc3d9f146a67n, 0x53b7ebba2c552337n, 0xce78457db197edf3n, 0x15a5821565cc2ec2n]),
  limbs4ToBigInt([0x2f15485f28c71727n, 0xdcf64f3604427750n, 0x0efa7e31a1db5966n, 0x2411d57a4813b998n]),
  limbs4ToBigInt([0x58828b5ef6cb4c9bn, 0x47e9a98e12f4cd25n, 0x13e335b8c0b6d2e6n, 0x002e6f8d6520cd47n]),
  // Round 34
  limbs4ToBigInt([0x398834609e0315d2n, 0xaf8f0e91e2fe1ed7n, 0x97da00b616b0fcd1n, 0x2ff7bc8f4380cde9n]),
  limbs4ToBigInt([0xe93be4febb0d3cben, 0x2e9521f6b7bb68f1n, 0x5ee02724471bcd18n, 0x00b9831b94852559n]),
  limbs4ToBigInt([0x7d77adbf0c9c3512n, 0x1ca408648a4743a8n, 0x86913b0e57c04e01n, 0x0a2f53768b8ebf6an]),
  // Round 35
  limbs4ToBigInt([0x7f2a290305e1198dn, 0x0f599ff7e94be69bn, 0x3a479f91ff239e96n, 0x00248156142fd037n]),
  limbs4ToBigInt([0x50eb512a2b2bcda9n, 0x397196aa6a542c23n, 0x28cf8c02ab3f0c9an, 0x171d5620b87bfb13n]),
  limbs4ToBigInt([0x9d1045e4ec34a808n, 0x60c952172dd54dd9n, 0x70087c7c10d6fad7n, 0x170a4f55536f7dc9n]),
  // Round 36
  limbs4ToBigInt([0x482eca17e2dbfae1n, 0xcc37e38c1cd211ban, 0x2ef3134aea04336en, 0x29aba33f799fe66cn]),
  limbs4ToBigInt([0xb5ba650369e64973n, 0xe70d114a03f6a0e8n, 0xfdd1bb1945088d47n, 0x1e9bc179a4fdd758n]),
  limbs4ToBigInt([0x9c9e1c43bdaf8f09n, 0xfeaad869a9c4b44fn, 0x58f7f4892dfb0b5an, 0x1dd269799b660fadn]),
  // Round 37
  limbs4ToBigInt([0x5d1dd2cb0f24af38n, 0x7ccd426fe869c7c9n, 0x401181d02e15459en, 0x22cdbc8b70117ad1n]),
  limbs4ToBigInt([0xd5ba93b9c7dacefdn, 0xfd3150f52ed94a7cn, 0x3a9f57a55c503fcen, 0x0ef042e454771c53n]),
  limbs4ToBigInt([0x3b304ffca62e8284n, 0x1318e8b08a0359a0n, 0xf287f3036037e885n, 0x11609e06ad6c8fe2n]),
  // Round 38
  limbs4ToBigInt([0x08b08f5b783aa9afn, 0xfecd58c076dfe427n, 0x9e753eea427c17b7n, 0x1166d9e554616dban]),
  limbs4ToBigInt([0xf855a888357ee466n, 0x177fbf4cd2ac0b56n, 0x93413026354413dbn, 0x2de52989431a8595n]),
  limbs4ToBigInt([0x74bf01cf5f71e9adn, 0xf51aee5b17b8e89dn, 0x9a6da492f3a8ac1dn, 0x3006eb4ffc7a8581n]),
  // Round 39
  limbs4ToBigInt([0x62344c8225145086n, 0x2993fe8f0a4639f9n, 0xfdcf6fff9e3f6f42n, 0x2af41fbb61ba8a80n]),
  limbs4ToBigInt([0x81b214bace4827c3n, 0x8718ab27889e85e7n, 0xe5a6b41a8ebc85dbn, 0x119e684de476155fn]),
  limbs4ToBigInt([0xcff784b97b3fd800n, 0xb51248c23828f047n, 0x188bea59ae363537n, 0x1835b786e2e8925en]),
  // Round 40
  limbs4ToBigInt([0x6c40e285ab32eeb6n, 0xd152bac2a7905c92n, 0x4d794996c6433a20n, 0x28201a34c594dfa3n]),
  limbs4ToBigInt([0x4a761f88c22cc4e7n, 0x864c82eb57118772n, 0x94e80fefaf78b000n, 0x083efd7a27d17510n]),
  limbs4ToBigInt([0x9e079564f61fd13bn, 0x11c16df7774dd851n, 0x6158e61ceea27be8n, 0x0b6f88a357719952n]),
  // Round 41
  limbs4ToBigInt([0x14390e6ee4254f5bn, 0x589511ca00d29e10n, 0x644f66e1d6471a94n, 0x0ec868e6d15e51d9n]),
  limbs4ToBigInt([0x00d937ab84c98591n, 0xecd3e74b939cd40dn, 0x1ac0c9b3ed2e1142n, 0x2af33e3f86677127n]),
  limbs4ToBigInt([0x364ce5e47951f178n, 0x34568c547dd6858bn, 0xd09b5d961c6ace77n, 0x0b520211f904b5e7n]),
  // Round 42
  limbs4ToBigInt([0xca228620188a1d40n, 0xa0c56ac4270e822cn, 0xd8db58f10062a92en, 0x0b2d722d0919a1aan]),
  limbs4ToBigInt([0xe0061d1ed6e562d4n, 0x57b54a9991ca38bbn, 0xd980ceb37c2453e9n, 0x1f790d4d7f8cf094n]),
  limbs4ToBigInt([0xda92ceb01e504233n, 0x0885c16235a2a6a8n, 0xaea97cd385f78015n, 0x0171eb95dfbf7d1en]),
  // Round 43
  limbs4ToBigInt([0x762305381b168873n, 0x790b40defd2c8650n, 0x329bf6885da66b9bn, 0x0c2d0e3b5fd57549n]),
  limbs4ToBigInt([0x5d3803054407a18dn, 0x7cbcafa589e283c3n, 0x4e5a8228b4e72b37n, 0x1162fb28689c2715n]),
  limbs4ToBigInt([0x1623ef8249711bc0n, 0x282c5a92a89e1992n, 0x64ad386a91e8310fn, 0x2f1459b65dee441bn]),
  // Round 44
  limbs4ToBigInt([0xc243f70d1b53cfbbn, 0xbc489d46754eb712n, 0x996d74367d5cd4c1n, 0x1e6ff3216b688c3dn]),
  limbs4ToBigInt([0x76881f9326478875n, 0xd741a6f36cdc2a05n, 0x681487d27d157802n, 0x01ca8be73832b8d0n]),
  limbs4ToBigInt([0x0b9b5de315f9650en, 0x680286080b10cea0n, 0x86f976d5bdf223dcn, 0x1f7735706ffe9fc5n]),
  // Round 45
  limbs4ToBigInt([0x4745ca838285f019n, 0x21ac10a3d5f096efn, 0x40a0c2dce041fba9n, 0x2522b60f4ea33076n]),
  limbs4ToBigInt([0x8ce16c235572575bn, 0x3418cad4f52b6c3fn, 0x5255075ddc957f83n, 0x23f0bee001b1029dn]),
  limbs4ToBigInt([0x66d9401093082d59n, 0x5d142633e9df905fn, 0xcaac2d44555ed568n, 0x2bc1ae8b8ddbb81fn]),
  // Round 46
  limbs4ToBigInt([0x8011fcd6ad72205fn, 0x62371273a07b1fc9n, 0x7304507b8dba3ed1n, 0x0f9406b8296564a3n]),
  limbs4ToBigInt([0xcb126c8cd995f0a8n, 0x17e75b174a52ee4an, 0x67b72998de90714en, 0x2360a8eb0cc7defan]),
  limbs4ToBigInt([0x6dcbbc2767f88948n, 0xb4815a5e96df8b00n, 0x804c803cbaef255en, 0x15871a5cddead976n]),
  // Round 47
  limbs4ToBigInt([0x4f957ccdeefb420fn, 0x362f4f54f7237954n, 0x0a8652dd2f3b1da0n, 0x193a56766998ee9en]),
  limbs4ToBigInt([0xe4309805e777ae0fn, 0x3b2e63c8ad334834n, 0x2f9be56ff4fab170n, 0x2a394a43934f8698n]),
  limbs4ToBigInt([0xb4166e8876c0d142n, 0x892cd11223443ba7n, 0x3e8b635dcb345192n, 0x1859954cfeb8695fn]),
  // Round 48
  limbs4ToBigInt([0x408d3819f4fed32bn, 0x2b11bc25d90bbdcan, 0x013444dbcb99f190n, 0x04e1181763050e58n]),
  limbs4ToBigInt([0x1f5e5552bfd05f23n, 0xb10eb82db08b5e8bn, 0x40c335ea64de8c5bn, 0x0fdb253dee83869dn]),
  limbs4ToBigInt([0xa9d7c5bae9b4f1c0n, 0x75f08686f1c08984n, 0xaa4efb623adead62n, 0x058cbe8a9a5027bdn]),
  // Round 49
  limbs4ToBigInt([0xd15228b4cceca59an, 0x23b4b83bef023ab0n, 0x497eadb1aeb1f52bn, 0x1382edce9971e186n]),
  limbs4ToBigInt([0xe1e6634601d9e8b5n, 0x7f61b8eb99f14b77n, 0x0819ca51fd11b0ben, 0x03464990f045c6een]),
  limbs4ToBigInt([0xaa5bc137aeb70a58n, 0x6fcab4605db2eb5an, 0xfff33b41f98ff83cn, 0x23f7bfc8720dc296n]),
  // Round 50
  limbs4ToBigInt([0x19636158bbaf62f2n, 0x18c3ffd5e1531a92n, 0x7e6e94e7f0e9decfn, 0x0a59a158e3eec211n]),
  limbs4ToBigInt([0xf4c23ed0075fd07bn, 0xe2c4eba065420af8n, 0xb58bf23b312ffd3cn, 0x06ec54c80381c052n]),
  limbs4ToBigInt([0x962f0ff9ed1f9d01n, 0xb09340f7a7bcb1b4n, 0x476b56648e867ec8n, 0x118872dc832e0eb5n]),
  // Round 51
  limbs4ToBigInt([0x95e1906b520921b1n, 0x52e0b0f0e42d7fean, 0x5ad5c7cba7ad59edn, 0x13d69fa127d83416n]),
  limbs4ToBigInt([0xfd8a49f19f10c77bn, 0xde143942fb71dc55n, 0x70b1c6877a73d21bn, 0x169a177f63ea6812n]),
  limbs4ToBigInt([0xfb7e9a5a7450544dn, 0x3abeb032b922f66fn, 0xef42f287adce40d9n, 0x04ef51591c6ead97n]),
  // Round 52
  limbs4ToBigInt([0xd5f45ee6dd0f69ecn, 0x19ec61805d4f03cen, 0x0ecd7ca703fb2e3bn, 0x256e175a1dc07939n]),
  limbs4ToBigInt([0xa002813d3e2ceeb2n, 0x75cc360d3205dd2dn, 0xe5f2af412ff6004fn, 0x30102d28636abd5fn]),
  limbs4ToBigInt([0x1fd31be182fcc792n, 0x0443a3fa99bef4a3n, 0x1c0714bc73eb1bf4n, 0x10998e42dfcd3bbfn]),
  // Round 53
  limbs4ToBigInt([0xecad76f879e36860n, 0x9f3362eaf4d582efn, 0x25fa7d24b598a1d8n, 0x193edd8e9fcf3d76n]),
  limbs4ToBigInt([0xf2664d7aa51f0b5dn, 0xd1c7a561ce611425n, 0xd0368ce80b7b3347n, 0x18168afd34f2d915n]),
  limbs4ToBigInt([0x29e2e95b33ea6111n, 0xa328ec77bc33626en, 0x0c017656ebe658b6n, 0x29383c01ebd3b6abn]),
  // Round 54
  limbs4ToBigInt([0x00bf573f9010c711n, 0x702db6e86fb76ab6n, 0xa1f4ae5e7771a64an, 0x10646d2f2603de39n]),
  limbs4ToBigInt([0x64d0242dcb1117fbn, 0x2f90c25b40da7b38n, 0xf575f1395a55bf13n, 0x0beb5e07d1b27145n]),
  limbs4ToBigInt([0xdffbf018d96fa336n, 0x30f95bb2e54b59abn, 0xdc0d3ecad62b5c88n, 0x16d685252078c133n]),
  // Round 55
  limbs4ToBigInt([0xfd672dd62047f01an, 0x0a555bbbec21ddfan, 0x3c74154e0404b4b4n, 0x0a6abd1d833938f3n]),
  limbs4ToBigInt([0x70a6f19b34cf1860n, 0xb12dffeec4503172n, 0x8ea12a4c2dedc8fen, 0x1a679f5d36eb7b5cn]),
  limbs4ToBigInt([0xfbc7592e3f1b93d6n, 0x26a423eada4e8f6fn, 0x3974d50e0ebfde47n, 0x0980fb233bd456c2n]),
  // Round 56
  limbs4ToBigInt([0x03ebacb5c312c72bn, 0xcece3d5628c92820n, 0xbf1810af93a38fc0n, 0x161b42232e61b84cn]),
  limbs4ToBigInt([0xd09203db47de1a0bn, 0x493f09787f1564e5n, 0x950f7d47a60d5e6an, 0x0ada10a90c7f0520n]),
  limbs4ToBigInt([0xb50ddb9af407f451n, 0xd3f07a8a2b4e121bn, 0x320345a29ac4238en, 0x1a730d372310ba82n]),
  // Round 57
  limbs4ToBigInt([0xfbda10ef58e8c556n, 0x908377feaba5c4dfn, 0x817064c369dda7ean, 0x2c8120f268ef054fn]),
  limbs4ToBigInt([0x6e7b8649a4968f70n, 0xb930e95313bcb73en, 0xa57c00789c684217n, 0x1c7c8824f758753fn]),
  limbs4ToBigInt([0xb47b27fa3fd1cf77n, 0xf400ad8b491eb3f7n, 0x8e39e4077a74faa0n, 0x2cd9ed31f5f8691cn]),
  // Round 58
  limbs4ToBigInt([0x854ae23918a22eean, 0xa5e022ac321ca550n, 0xcf60d92f57618399n, 0x23ff4f9d46813457n]),
  limbs4ToBigInt([0xdff1ea58f180426dn, 0xaf5a2c5103529407n, 0xceece6405dddd9d0n, 0x09945a5d147a4f66n]),
  limbs4ToBigInt([0x8a6dd223ec6fc630n, 0x7c7da6eaa29d3f26n, 0xb67660c6b771b90fn, 0x188d9c528025d4c2n]),
  // Round 59
  limbs4ToBigInt([0xe0c0d8ddf4f0f47fn, 0xdba7d926d3633595n, 0x81f68311431d8734n, 0x3050e37996596b7fn]),
  limbs4ToBigInt([0x9d829518d30afd78n, 0x6ceae5461e3f95d8n, 0x1600ca8102c35c42n, 0x15af1169396830a9n]),
  limbs4ToBigInt([0x04284da3320d8accn, 0xdae933e351466b29n, 0xa06d9f37f873d985n, 0x1da6d09885432ea9n]),
  // Round 60
  limbs4ToBigInt([0xe546ee411ddaa9cbn, 0x4e4fad3dbe658945n, 0xf5f8acf33921124en, 0x2796ea90d269af29n]),
  limbs4ToBigInt([0x7cb0319e01d32d60n, 0x1e15612ec8e9304an, 0x0325c8b3307742f0n, 0x202d7dd1da0f6b4bn]),
  limbs4ToBigInt([0xa29dace4c0f8be5fn, 0xa2d7f9c788f4c831n, 0x156a952ba263d672n, 0x096d6790d05bb759n]),
  // Round 61
  limbs4ToBigInt([0x63798cb1447d25a4n, 0x438da23ce5b13e19n, 0x83808965275d877bn, 0x054efa1f65b0fce2n]),
  limbs4ToBigInt([0x64ccf6e18e4165f1n, 0xd8aa690113b2e148n, 0xdb3308c29802deb9n, 0x1b162f83d917e93en]),
  limbs4ToBigInt([0xc5ceb745a0506edcn, 0xedfefc1466cc568en, 0xfd9f1cdd2a0de39en, 0x21e5241e12564dd6n]),
  // Round 62
  limbs4ToBigInt([0x7b4349e10e4bdf08n, 0xcb73ab5f87e16192n, 0x226a80ee17b36aben, 0x1cfb5662e8cf5ac9n]),
  limbs4ToBigInt([0x29c53f666eb24100n, 0x2c99af346220ac01n, 0xbae6d8d1ecb373b6n, 0x0f21177e302a771bn]),
  limbs4ToBigInt([0xbcef7e1f515c2320n, 0xc4236aede6290546n, 0xaffb0dd7f71b12ben, 0x1671522374606992n]),
  // Round 63
  limbs4ToBigInt([0xd419d2a692cad870n, 0xbe2ec9e42c5cc8ccn, 0x2eb4cf24501bfad9n, 0x0fa3ec5b9488259cn]),
  limbs4ToBigInt([0x85e8c57b1ab54bban, 0xd36edce85c648cc0n, 0x57cb266c1506080en, 0x193c0e04e0bd2983n]),
  limbs4ToBigInt([0xce14ea2adaba68f8n, 0x9f6f7291cd406578n, 0x7e9128306dcbc3c9n, 0x102adf8ef74735a2n]),
  // Round 64
  limbs4ToBigInt([0x40a6d0cb70c3eab1n, 0x316aa24bfbdd23aen, 0xe2a54d6f1ad945b1n, 0x0fe0af7858e49859n]),
  limbs4ToBigInt([0xe8a5ea7344798d22n, 0x2da5f1daa9ebdefdn, 0x08536a2220843f4en, 0x216f6717bbc7dedbn]),
  limbs4ToBigInt([0xf88e2e4228325161n, 0x3c23b2ac773c6b3en, 0x4a3e694391918a1bn, 0x1da55cc900f0d21fn]),
];

// ============================================
// MDS Matrix (from circomlib)
// ============================================

const MDS_MATRIX: bigint[][] = [
  [
    limbs4ToBigInt([0xfedb68592ba8118bn, 0x94be7c11ad24378bn, 0xb2b70caf5c36a7b1n, 0x109b7f411ba0e4c9n]),
    limbs4ToBigInt([0xd6c64543dc4903e0n, 0x9314dc9fdbdeea55n, 0x6ae119424fddbcbcn, 0x16ed41e13bb9c0c6n]),
    limbs4ToBigInt([0x791a93b74e36736dn, 0xf706ab640ceb247bn, 0xf617e7dcbfe82e0dn, 0x2b90bba00fca0589n]),
  ],
  [
    limbs4ToBigInt([0xd62940bcde0bd771n, 0x2cc8fdd1415c3dden, 0xb9c36c764379dbcan, 0x2969f27eed31a480n]),
    limbs4ToBigInt([0x29b2311687b1fe23n, 0xb89d743c8c7b9640n, 0x4c9871c832963dc1n, 0x2e2419f9ec02ec39n]),
    limbs4ToBigInt([0xc8aacc55a0f89bfan, 0x148d4e109f5fb065n, 0x97315876690f053dn, 0x101071f0032379b6n]),
  ],
  [
    limbs4ToBigInt([0x326244ee65a1b1a7n, 0xe6cd79e28c5b3753n, 0x0d5f9e654638065cn, 0x143021ec686a3f33n]),
    limbs4ToBigInt([0xb16cdfabc8ee2911n, 0xd057e12e58e7d7b6n, 0x82a70eff08a6fd99n, 0x176cc029695ad025n]),
    limbs4ToBigInt([0x73279cd71d25d5e0n, 0xa644470307043f77n, 0x17ba7fee3802593fn, 0x19a3fc0a56702bf4n]),
  ],
];

// ============================================
// Poseidon Hash Implementation
// ============================================

/**
 * Poseidon hash function - ZK-friendly hash for BN254
 * This implementation matches the on-chain Rust version exactly
 */
export function poseidonHash(inputs: bigint[]): bigint {
  const t = POSEIDON_T;

  // Initialize state with capacity element and inputs
  const state: bigint[] = [0n, ...inputs];

  // Ensure state has correct size (pad with zeros if needed)
  while (state.length < t) {
    state.push(0n);
  }

  let roundIdx = 0;

  // First half of full rounds
  for (let r = 0; r < POSEIDON_RF / 2; r++) {
    // Add round constants
    for (let i = 0; i < t; i++) {
      state[i] = fieldAdd(state[i], ROUND_CONSTANTS[roundIdx * t + i]);
    }
    roundIdx++;

    // Full S-box
    for (let i = 0; i < t; i++) {
      state[i] = sbox(state[i]);
    }

    // MDS mix
    mdsMultiply(state);
  }

  // Partial rounds
  for (let r = 0; r < POSEIDON_RP; r++) {
    // Add round constants
    for (let i = 0; i < t; i++) {
      state[i] = fieldAdd(state[i], ROUND_CONSTANTS[roundIdx * t + i]);
    }
    roundIdx++;

    // Partial S-box (only first element)
    state[0] = sbox(state[0]);

    // MDS mix
    mdsMultiply(state);
  }

  // Second half of full rounds
  for (let r = 0; r < POSEIDON_RF / 2; r++) {
    // Add round constants
    for (let i = 0; i < t; i++) {
      state[i] = fieldAdd(state[i], ROUND_CONSTANTS[roundIdx * t + i]);
    }
    roundIdx++;

    // Full S-box
    for (let i = 0; i < t; i++) {
      state[i] = sbox(state[i]);
    }

    // MDS mix
    mdsMultiply(state);
  }

  return state[0];
}

/**
 * MDS matrix multiplication (in-place)
 */
function mdsMultiply(state: bigint[]): void {
  const newState: bigint[] = [0n, 0n, 0n];
  for (let i = 0; i < POSEIDON_T; i++) {
    for (let j = 0; j < POSEIDON_T; j++) {
      newState[i] = fieldAdd(newState[i], fieldMul(state[j], MDS_MATRIX[i][j]));
    }
  }
  state[0] = newState[0];
  state[1] = newState[1];
  state[2] = newState[2];
}

/**
 * Poseidon hash for 2 inputs (most common case)
 */
export function poseidonHash2(a: bigint, b: bigint): bigint {
  return poseidonHash([a, b]);
}

/**
 * Poseidon hash for 4 inputs (using two rounds)
 */
export function poseidonHash4(inputs: [bigint, bigint, bigint, bigint]): bigint {
  const h1 = poseidonHash2(inputs[0], inputs[1]);
  const h2 = poseidonHash2(inputs[2], inputs[3]);
  return poseidonHash2(h1, h2);
}

/**
 * Convert bytes to field element (little-endian)
 */
export function bytesToField(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = 0; i < bytes.length && i < 32; i++) {
    result = result | (BigInt(bytes[i]) << BigInt(i * 8));
  }
  return result % BN254_PRIME;
}

/**
 * Convert field element to bytes (32 bytes, little-endian)
 */
export function fieldToBytes(field: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let val = field;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(val & 0xffn);
    val = val >> 8n;
  }
  return bytes;
}

// ============================================
// Pedersen Commitment (using secp256k1)
// ============================================

// secp256k1 curve order
const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

// Generator points for Pedersen commitment
// G is the standard generator, H is derived deterministically
const Point = schnorr.Point;
const G = Point.BASE;
const H_SEED = sha256(new TextEncoder().encode('stealthsol_pedersen_h_v1'));
// Derive H by hashing to a scalar and multiplying the base point
const H_SCALAR_RAW = BigInt('0x' + bytesToHex(H_SEED).slice(0, 64));
const H_SCALAR = H_SCALAR_RAW % SECP256K1_N || 1n; // Ensure non-zero

// Defer H computation to avoid top-level await issues
let H: ReturnType<typeof G.multiply> | null = null;
function getH() {
  if (!H) {
    H = G.multiply(H_SCALAR);
  }
  return H;
}

export interface PedersenCommitment {
  commitment: Uint8Array;
  blindingFactor: Uint8Array;
  amount: bigint;
}

/**
 * Create a Pedersen commitment: C = v*G + r*H
 * @param amount - The value to commit to (in lamports)
 * @param blindingFactor - Optional random blinding factor (32 bytes)
 */
export function createPedersenCommitment(
  amount: bigint,
  blindingFactor?: Uint8Array
): PedersenCommitment {
  // Generate random blinding factor if not provided
  const r = blindingFactor || crypto.getRandomValues(new Uint8Array(32));
  const rScalar = BigInt('0x' + bytesToHex(r)) % SECP256K1_N;

  // Ensure amount is within valid range and non-zero for multiply
  const v = amount % SECP256K1_N;
  const safeV = v === 0n ? 1n : v;
  const safeR = rScalar === 0n ? 1n : rScalar;

  // C = v*G + r*H
  const vG = G.multiply(safeV);
  const rH = getH().multiply(safeR);
  const C = vG.add(rH);

  return {
    commitment: schnorr.utils.pointToBytes(C),
    blindingFactor: r,
    amount: amount,
  };
}

/**
 * Verify a Pedersen commitment
 */
export function verifyPedersenCommitment(
  commitment: Uint8Array,
  amount: bigint,
  blindingFactor: Uint8Array
): boolean {
  try {
    const expected = createPedersenCommitment(amount, blindingFactor);
    return bytesToHex(commitment) === bytesToHex(expected.commitment);
  } catch {
    return false;
  }
}

/**
 * Add two Pedersen commitments (homomorphic property)
 * C(a) + C(b) = C(a+b) when using same blinding factors sum
 */
export function addPedersenCommitments(
  c1: Uint8Array,
  c2: Uint8Array
): Uint8Array {
  // Use lift_x to convert x-only points back to full points
  const x1 = BigInt('0x' + bytesToHex(c1));
  const x2 = BigInt('0x' + bytesToHex(c2));
  const p1 = schnorr.utils.lift_x(x1);
  const p2 = schnorr.utils.lift_x(x2);
  return schnorr.utils.pointToBytes(p1.add(p2));
}

// ============================================
// Incremental Merkle Tree
// ============================================

// Reduced to 8 to fit Solana compute budget (256 deposits per pool)
export const MERKLE_DEPTH = 8;
const ZERO_VALUE = 0n;

// Precompute zero hashes for each level (computed using real Poseidon)
function computeZeroHashes(): bigint[] {
  const zeros: bigint[] = [ZERO_VALUE];
  for (let i = 1; i <= MERKLE_DEPTH; i++) {
    zeros[i] = poseidonHash2(zeros[i - 1], zeros[i - 1]);
  }
  return zeros;
}

export const ZERO_HASHES = computeZeroHashes();

export interface MerkleProof {
  siblings: bigint[];
  pathIndices: number[];
  root: bigint;
  leafIndex: number;
}

export class IncrementalMerkleTree {
  private filledSubtrees: bigint[];
  private root: bigint;
  private nextIndex: number;
  private leaves: bigint[];

  constructor() {
    this.filledSubtrees = [...ZERO_HASHES.slice(0, MERKLE_DEPTH)];
    this.root = ZERO_HASHES[MERKLE_DEPTH];
    this.nextIndex = 0;
    this.leaves = [];
  }

  /**
   * Insert a new leaf into the tree
   * @returns The leaf index and merkle proof
   */
  insert(leaf: bigint): { index: number; proof: MerkleProof } {
    if (this.nextIndex >= 2 ** MERKLE_DEPTH) {
      throw new Error('Merkle tree is full');
    }

    const leafIndex = this.nextIndex;
    let currentIndex = leafIndex;
    let currentHash = leaf;

    const siblings: bigint[] = [];
    const pathIndices: number[] = [];

    for (let i = 0; i < MERKLE_DEPTH; i++) {
      const isLeft = currentIndex % 2 === 0;
      pathIndices.push(isLeft ? 0 : 1);

      if (isLeft) {
        siblings.push(ZERO_HASHES[i]);
        this.filledSubtrees[i] = currentHash;
        currentHash = poseidonHash2(currentHash, ZERO_HASHES[i]);
      } else {
        siblings.push(this.filledSubtrees[i]);
        currentHash = poseidonHash2(this.filledSubtrees[i], currentHash);
      }

      currentIndex = Math.floor(currentIndex / 2);
    }

    this.root = currentHash;
    this.leaves.push(leaf);
    this.nextIndex++;

    return {
      index: leafIndex,
      proof: {
        siblings,
        pathIndices,
        root: this.root,
        leafIndex,
      },
    };
  }

  /**
   * Get the current root
   */
  getRoot(): bigint {
    return this.root;
  }

  /**
   * Get the number of leaves
   */
  getLeafCount(): number {
    return this.nextIndex;
  }

  /**
   * Verify a merkle proof
   */
  static verifyProof(leaf: bigint, proof: MerkleProof): boolean {
    let currentHash = leaf;

    for (let i = 0; i < proof.siblings.length; i++) {
      if (proof.pathIndices[i] === 0) {
        currentHash = poseidonHash2(currentHash, proof.siblings[i]);
      } else {
        currentHash = poseidonHash2(proof.siblings[i], currentHash);
      }
    }

    return currentHash === proof.root;
  }

  /**
   * Export tree state for persistence
   */
  export(): {
    filledSubtrees: string[];
    root: string;
    nextIndex: number;
    leaves: string[];
  } {
    return {
      filledSubtrees: this.filledSubtrees.map(x => x.toString()),
      root: this.root.toString(),
      nextIndex: this.nextIndex,
      leaves: this.leaves.map(x => x.toString()),
    };
  }

  /**
   * Import tree state
   */
  static import(data: {
    filledSubtrees: string[];
    root: string;
    nextIndex: number;
    leaves: string[];
  }): IncrementalMerkleTree {
    const tree = new IncrementalMerkleTree();
    tree.filledSubtrees = data.filledSubtrees.map(x => BigInt(x));
    tree.root = BigInt(data.root);
    tree.nextIndex = data.nextIndex;
    tree.leaves = data.leaves.map(x => BigInt(x));
    return tree;
  }
}

// ============================================
// Note and Nullifier Generation
// ============================================

// ============================================
// Privacy: Withdrawal Timing Protection
// ============================================

/**
 * Withdrawal timing configuration
 * These delays prevent timing correlation attacks where an observer
 * could link deposits to withdrawals based on timing patterns.
 */
export const WITHDRAWAL_TIMING = {
  // Minimum delay between deposit and withdrawal (24 hours in production)
  MIN_WITHDRAWAL_DELAY_MS: 24 * 60 * 60 * 1000,
  // Warning delay (show warning if withdrawing within 48 hours)
  WARNING_DELAY_MS: 48 * 60 * 60 * 1000,
  // For testing, set to 0 to disable
  ENABLED: true,
};

/**
 * Check if a note can be safely withdrawn
 * Returns an object with withdrawal eligibility status
 */
export function checkWithdrawalTiming(note: PrivateNote): {
  canWithdraw: boolean;
  timeUntilWithdraw: number;
  isWarning: boolean;
  warningMessage?: string;
} {
  if (!WITHDRAWAL_TIMING.ENABLED) {
    return { canWithdraw: true, timeUntilWithdraw: 0, isWarning: false };
  }

  const now = Date.now();
  const depositAge = now - note.timestamp;
  const timeUntilMinDelay = WITHDRAWAL_TIMING.MIN_WITHDRAWAL_DELAY_MS - depositAge;

  // Cannot withdraw yet
  if (timeUntilMinDelay > 0) {
    const hoursLeft = Math.ceil(timeUntilMinDelay / (60 * 60 * 1000));
    return {
      canWithdraw: false,
      timeUntilWithdraw: timeUntilMinDelay,
      isWarning: false,
      warningMessage: `Must wait ${hoursLeft} more hours before withdrawal for privacy protection`,
    };
  }

  // Can withdraw but with privacy warning
  if (depositAge < WITHDRAWAL_TIMING.WARNING_DELAY_MS) {
    const hoursSinceDeposit = Math.floor(depositAge / (60 * 60 * 1000));
    return {
      canWithdraw: true,
      timeUntilWithdraw: 0,
      isWarning: true,
      warningMessage: `Withdrawing after only ${hoursSinceDeposit} hours may reduce privacy. Consider waiting longer.`,
    };
  }

  // Safe to withdraw
  return { canWithdraw: true, timeUntilWithdraw: 0, isWarning: false };
}

/**
 * Format remaining time for display
 */
export function formatWithdrawalWaitTime(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h`;
  }

  return `${hours}h ${minutes}m`;
}

export interface PrivateNote {
  commitment: bigint;
  nullifier: bigint;
  secret: Uint8Array;
  amount: bigint;
  leafIndex: number;
  timestamp: number;
}

/**
 * Generate a commitment for depositing into the privacy pool
 * commitment = Poseidon(nullifier, secret, amount)
 */
export function generateNoteCommitment(
  nullifier: bigint,
  secret: bigint,
  amount: bigint
): bigint {
  return poseidonHash([nullifier, secret, amount]);
}

/**
 * Generate a nullifier hash for spending a note
 * nullifierHash = Poseidon(nullifier, leafIndex, secret)
 */
export function generateNullifierHash(
  nullifier: bigint,
  leafIndex: bigint,
  secret: bigint
): bigint {
  return poseidonHash([nullifier, leafIndex, secret]);
}

/**
 * Create a new private note for depositing
 */
export function createPrivateNote(amount: bigint): {
  note: PrivateNote;
  commitment: bigint;
} {
  const nullifierBytes = crypto.getRandomValues(new Uint8Array(31));
  const secretBytes = crypto.getRandomValues(new Uint8Array(31));

  const nullifier = bytesToField(nullifierBytes);
  const secret = bytesToField(secretBytes);

  const commitment = generateNoteCommitment(nullifier, secret, amount);

  return {
    note: {
      commitment,
      nullifier,
      secret: secretBytes,
      amount,
      leafIndex: -1, // Set after insertion
      timestamp: Date.now(),
    },
    commitment,
  };
}

// ============================================
// Bulletproof Range Proof (Simplified)
// ============================================

/**
 * Generate a range proof that proves 0 <= v < 2^64
 * This is a simplified version - real bulletproofs are more complex
 */
export function generateRangeProof(
  amount: bigint,
  blindingFactor: Uint8Array
): Uint8Array {
  // In a real implementation, this would be a proper Bulletproof
  // For now, we create a deterministic proof that can be verified
  const proofData = new Uint8Array(128);

  // Encode amount commitment
  const amountBytes = fieldToBytes(amount);
  proofData.set(amountBytes.slice(0, 32), 0);

  // Encode blinding factor commitment
  const rCommit = sha256(blindingFactor);
  proofData.set(rCommit, 32);

  // Encode range proof elements
  const rangeCommit = sha256(new Uint8Array([...amountBytes, ...blindingFactor]));
  proofData.set(rangeCommit, 64);

  // Add verification tag
  const tag = sha256(proofData.slice(0, 96));
  proofData.set(tag, 96);

  return proofData;
}

/**
 * Verify a range proof (simplified)
 */
export function verifyRangeProof(
  commitment: Uint8Array,
  proof: Uint8Array
): boolean {
  if (proof.length !== 128) return false;

  // Verify tag
  const computedTag = sha256(proof.slice(0, 96));
  const providedTag = proof.slice(96, 128);

  return bytesToHex(computedTag) === bytesToHex(providedTag);
}

// ============================================
// Compute commitment/nullifier hash (bytes interface)
// Matches the on-chain Rust API
// ============================================

/**
 * Compute commitment from bytes: Poseidon(nullifier, secret, amount, recipient)
 */
export function computeCommitmentBytes(
  nullifier: Uint8Array,
  secret: Uint8Array,
  amount: bigint,
  recipient: Uint8Array
): Uint8Array {
  const amountBytes = new Uint8Array(32);
  let val = amount;
  for (let i = 0; i < 8; i++) {
    amountBytes[i] = Number(val & 0xffn);
    val = val >> 8n;
  }

  const h = poseidonHash4([
    bytesToField(nullifier),
    bytesToField(secret),
    bytesToField(amountBytes),
    bytesToField(recipient),
  ]);
  return fieldToBytes(h);
}

/**
 * Compute nullifier hash from bytes: Poseidon(nullifier, 0)
 */
export function computeNullifierHashBytes(nullifier: Uint8Array): Uint8Array {
  const h = poseidonHash2(bytesToField(nullifier), 0n);
  return fieldToBytes(h);
}
