import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import { canonicalBytes, computeId } from "./unit.ts";
import type { Unit, UnitFrontmatter, UnseededUnit } from "./types.ts";

// @noble/ed25519 v2 requires sha512 to be set on etc.sha512Sync (and *Async)
(ed.etc as { sha512Sync?: (...m: Uint8Array[]) => Uint8Array }).sha512Sync = (
  ...m: Uint8Array[]
) => sha512(ed.etc.concatBytes(...m));

export interface Identity {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
}

export async function generateIdentity(): Promise<Identity> {
  const priv = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(priv);
  return { privateKey: priv, publicKey: pub, publicKeyHex: bytesToHex(pub) };
}

export function loadIdentity(privHex: string): Promise<Identity> {
  const priv = hexToBytes(privHex);
  return ed.getPublicKeyAsync(priv).then((pub) => ({
    privateKey: priv,
    publicKey: pub,
    publicKeyHex: bytesToHex(pub),
  }));
}

export async function signUnit(
  draft: UnseededUnit,
  identity: Identity,
): Promise<Unit> {
  const base = {
    topic: draft.topic,
    parents: draft.parents,
    author: identity.publicKeyHex,
    tags: draft.tags,
    summary: draft.summary,
    created_at: new Date().toISOString(),
  };
  const id = computeId(base, draft.body);
  const sigBytes = await ed.signAsync(hexToBytes(id), identity.privateKey);
  const fm: UnitFrontmatter = { ...base, id, sig: bytesToHex(sigBytes) };
  return { frontmatter: fm, body: draft.body };
}

export async function verifyUnit(unit: Unit): Promise<boolean> {
  const { frontmatter: fm, body } = unit;
  const expectedId = computeId(
    {
      topic: fm.topic,
      parents: fm.parents,
      author: fm.author,
      tags: fm.tags,
      summary: fm.summary,
      created_at: fm.created_at,
    },
    body,
  );
  if (expectedId !== fm.id) return false;
  try {
    return await ed.verifyAsync(
      hexToBytes(fm.sig),
      hexToBytes(fm.id),
      hexToBytes(fm.author),
    );
  } catch {
    return false;
  }
}
