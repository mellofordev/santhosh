export type Hash = string;
export type PubKeyHex = string;
export type SigHex = string;

export interface UnitFrontmatter {
  id: Hash;
  topic: string;
  parents: Hash[];
  author: PubKeyHex;
  tags: string[];
  summary: string;
  created_at: string;
  sig: SigHex;
}

export interface Unit {
  frontmatter: UnitFrontmatter;
  body: string;
}

export interface Header {
  id: Hash;
  topic: string;
  parents: Hash[];
  author: PubKeyHex;
  tags: string[];
  summary: string;
  created_at: string;
  sig: SigHex;
}

export interface UnseededUnit {
  topic: string;
  parents: Hash[];
  tags: string[];
  summary: string;
  body: string;
}
