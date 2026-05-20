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
    readonly serverPubKey: Uint8Array;
    readonly vtxoTapKey: Uint8Array;

    constructor(hrp: string, serverPubKey: Uint8Array, vtxoTapKey: Uint8Array) {
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
        this.serverPubKey = new Uint8Array(serverPubKey);
        this.vtxoTapKey = new Uint8Array(vtxoTapKey);
    }

    static fromP2TR(hrp: string,pay: ReturnType<typeof p2tr>, serverPubKey: Uint8Array): ArkAddress {
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
        const hrp = network === 'mainnet' ? 'ark' : 'tark';
        return new ArkAddress(hrp, serverPubKey, pay.tweakedPubkey);
    }

    encode(): string {
        if (!this.serverPubKey) {
            throw new Error("missing Server public key");
        }
        if (!this.vtxoTapKey) {
            throw new Error("missing vtxo tap public key");
        }

        // Version byte + two public keys (65 bytes total)
        const combined = new Uint8Array(65);
        combined[0] = 0x00; // v0 address format
        combined.set(this.serverPubKey, 1);
        combined.set(this.vtxoTapKey, 33);

        // Convert to 5-bit words and encode
        const words = bech32m.toWords(Array.from(combined));
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

        // Convert from 5-bit words to bytes (first byte is version)
        const bytes = bech32m.fromWords(words);

        // Skip version byte (first byte), split into Server and VTXO keys
        const serverPubKey = new Uint8Array(bytes.slice(1, 33));
        const vtxoTapKey = new Uint8Array(bytes.slice(33, 65));

        return new ArkAddress(prefix, serverPubKey, vtxoTapKey);
    }
}
