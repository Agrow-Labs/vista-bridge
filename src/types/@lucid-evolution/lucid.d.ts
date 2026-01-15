declare module '@lucid-evolution/lucid' {
  export interface Provider {
    [key: string]: any;
  }

  export class Blockfrost implements Provider {
    constructor(url: string, projectId: string);
    [key: string]: any;
  }

  export interface LucidInstance {
    [key: string]: any;
  }

  export type Network = 'Mainnet' | 'Testnet' | 'Preview' | 'Preprod';

  export function Lucid(
    provider: Provider,
    network?: Network
  ): Promise<LucidInstance>;

  export function validatorToAddress(
    network: Network,
    validator: any
  ): string;

  export namespace Data {
    export function to(data: any, schema?: any): string;
    export function from(cbor: string, schema?: any): any;
  }

  export class Constr {
    constructor(index: number, fields: any[]);
    index: number;
    fields: any[];
  }

  export function bytesFromHex(hex: string): Uint8Array;

  // CML is typically from @dcspark/cardano-multiplatform-lib-nodejs
  // but may be re-exported or available through lucid
  export const CML: any;

  export default Lucid;
}

