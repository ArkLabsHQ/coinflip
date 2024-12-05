import { bech32m } from 'bech32';
import { p2tr } from '@scure/btc-signer';
import { defaultVtxoTapscripts, vtxoScript } from '@/utils/taproot';
import { Bytes } from '@scure/btc-signer/utils';



interface Network {
    Addr: string;
}

interface Networks {
    Bitcoin: Network;
    TestNet: Network;
    RegTest: Network;
}

export const Networks: Networks = {
    Bitcoin: {
        Addr: "ark"
    },
    TestNet: {
        Addr: "tark"
    },
    RegTest: {
        Addr: "rark"
    }
};

export class ArkAddress {
    readonly hrp: string;
    readonly serverPubKey: Buffer;
    readonly vtxoTapKey: Buffer;

    constructor(hrp: string, serverPubKey: Buffer | Uint8Array, vtxoTapKey: Buffer | Uint8Array) {
        if (!['ark', 'tark', 'rark'].includes(hrp)) {
            throw new Error('Invalid HRP');
        }
        if (!serverPubKey || serverPubKey.length !== 32) {
            throw new Error('Server public key must be a 32-byte x-only pubkey');
        }
        if (!vtxoTapKey || vtxoTapKey.length !== 32) {
            throw new Error('VTXO taproot key must be a 32-byte x-only pubkey');
        }

        this.hrp = hrp;
        this.serverPubKey = Buffer.from(serverPubKey);
        this.vtxoTapKey = Buffer.from(vtxoTapKey);
    }

    static fromP2TR(hrp: string,pay: ReturnType<typeof p2tr>, serverPubKey: Buffer | Uint8Array): ArkAddress {
        if (!pay || !pay.tweakedPubkey) {
            throw new Error('Invalid P2TR output: missing output script');
        }
        if (!serverPubKey) {
            throw new Error('Server public key is required');
        }

        return new ArkAddress(
            hrp,
            serverPubKey,
            pay.tweakedPubkey
        );
    }

    static fromPubKey(pubKey: Bytes, serverPubKey: Bytes, network: string = 'testnet'): ArkAddress {
        const tapscripts = defaultVtxoTapscripts(pubKey, serverPubKey)
        const pay = vtxoScript(tapscripts)
        const hrp = network === 'mainnet' ? 'ark' : network === 'testnet' ? 'tark' : 'rark';
        return new ArkAddress(hrp, serverPubKey, pay.tweakedPubkey);
    }

    encode(): string {
        if (!this.serverPubKey) {
            throw new Error("missing Server public key");
        }
        if (!this.vtxoTapKey) {
            throw new Error("missing vtxo tap public key");
        }

        // Combine the two public keys
        const combinedKey = Buffer.concat([
            this.serverPubKey,
            this.vtxoTapKey
        ]);

        // Convert to 5-bit words
        const words = bech32m.toWords(Array.from(combinedKey));
        // Encode with bech32m
        return bech32m.encode(this.hrp, words, 1023);
    }

    static decode(addr: string): ArkAddress {
        if (!addr) {
            throw new Error("address is empty");
        }

        // Decode the bech32m string
        const { prefix, words } = bech32m.decode(addr, 1023);

        // Validate prefix
        if (![Networks.Bitcoin.Addr, Networks.TestNet.Addr, Networks.RegTest.Addr].includes(prefix)) {
            throw new Error("invalid prefix");
        }

        // Convert from 5-bit words to bytes
        const bytes = bech32m.fromWords(words);

        // Split into Server and VTXO keys
        const serverPubKey = bytes.slice(0, 32);
        const vtxoTapKey = bytes.slice(32, 64);

        return new ArkAddress(prefix, Buffer.from(serverPubKey), Buffer.from(vtxoTapKey));
    }
}