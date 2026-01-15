// Stub implementation for @lucid-evolution/lucid
// This is a temporary workaround until the package is properly installed with its dist folder

export class Blockfrost {
  constructor(public url: string, public projectId: string) {}
}

export interface LucidInstance {
  [key: string]: any;
}

export type Network = 'Mainnet' | 'Testnet' | 'Preview' | 'Preprod';

export async function Lucid(
  provider: any,
  network?: Network
): Promise<LucidInstance> {
  throw new Error('@lucid-evolution/lucid package is not properly installed. Please reinstall dependencies.');
}

export function validatorToAddress(network: Network, validator: any): string {
  throw new Error('@lucid-evolution/lucid package is not properly installed. Please reinstall dependencies.');
}

export namespace Data {
  export function to(data: any, schema?: any): string {
    throw new Error('@lucid-evolution/lucid package is not properly installed. Please reinstall dependencies.');
  }
  export function from(cbor: string, schema?: any): any {
    throw new Error('@lucid-evolution/lucid package is not properly installed. Please reinstall dependencies.');
  }
}

export class Constr {
  constructor(public index: number, public fields: any[]) {}
}

export function bytesFromHex(hex: string): Uint8Array {
  throw new Error('@lucid-evolution/lucid package is not properly installed. Please reinstall dependencies.');
}

export const CML: any = {};

export default Lucid;

