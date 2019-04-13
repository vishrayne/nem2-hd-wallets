/**
 * Copyright 2019 Grégory Saive for NEM Foundation
 *
 * Licensed under the BSD 2-Clause License (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://opensource.org/licenses/BSD-2-Clause
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
import {nacl_catapult, sha3Hasher} from 'nem2-library';
const bs58check = require('bs58check');
const createHash = require('create-hash');
const createHmac = require('create-hmac');

// internal dependencies
import { 
    NodeInterface,
    Network,
    Cryptography,
    CatapultECC
} from '../../index';

/**
 * Implementation of CKDPriv() function as described in SLIP-10
 * for multi-curve BIP32 compatibility with ED25519.
 *
 * Difference to BIP32:
 *  - Using 64-bytes master private key instead 32-bytes.
 *
 * @see https://cardanolaunch.com/assets/Ed25519_BIP.pdf
 * @see https://github.com/satoshilabs/slips/blob/master/slip-0010.md
 * @see https://github.com/alepop/ed25519-hd-key/blob/master/src/index.ts#L36
 * @param param0 
 * @param index 
 */
const CKDPriv = (
    parent: NodeEd25519,
    index: number
): NodeEd25519 => {
    const indexBuffer = Buffer.allocUnsafe(4);
    indexBuffer.writeUInt32BE(index, 0);

    // 0x00 || privateKey || index
    const data = Buffer.concat([Buffer.alloc(1, 0), parent.privateKey, indexBuffer]);

    const I = createHmac('sha512', parent.chainCode)
        .update(data)
        .digest();
    const IL = I.slice(0, 32);
    const IR = I.slice(32);

    // IL = privateKey ; IR = chainCode
    return new NodeEd25519(IL, undefined, IR);
};

/**
 * Implementation of CKDPub() function as described in the paper
 * at following URL:
 * 
 *     https://cardanolaunch.com/assets/Ed25519_BIP.pdf
 * 
 * This method permits to derive *child public keys* from extended
 * public keys (parent).
 *
 * This is not possible with the SLIP-10 proposal in BIP32 and 
 * presents an implementation proposal for the compatibility of
 * Extended Keys with Ed25519 ellyptic curves.
 *
 * @see https://cardanolaunch.com/assets/Ed25519_BIP.pdf
 * @param param0 
 * @param index 
 */
const CKDPub = (
    parent: NodeEd25519,
    index: number
): NodeEd25519 => {
    const indexBuffer = Buffer.allocUnsafe(4);
    indexBuffer.writeUInt32BE(index, 0);

    // publicKey || index
    const data = Buffer.concat([parent.publicKey, indexBuffer]);

    const I = createHmac('sha512', parent.chainCode)
        .update(data)
        .digest();
    const IL = I.slice(0, 32);
    const IR = I.slice(32);

    //XXX pointAddScalar(this.publicKey, IL) compatibility ?
    const Ki = parent.publicKey;
    nacl_catapult.add(Ki, IL);

    // In case Ki is the point at infinity, proceed with the next value for i
    if (Ki === null) {
        return CKDPub(parent, index + 1);
    }

    // Ki = publicKey ; IR = chainCode
    return new NodeEd25519(undefined, Ki, IR);
};

/**
 * Class `NodeEd25519` describes a hyper-deterministic BIP32 node
 * implementation, compatible with ed25519 EC-curve as described in
 * following paper :
 *
 *     https://cardanolaunch.com/assets/Ed25519_BIP.pdf
 *
 * It is an implementation of BIP32 that is adapted to work with 
 * ED25519 ellyptic curve keys rather than secp256k1 keys.
 *
 * This class *uses* features provided by the `bitcoinjs/bip32` package
 * and therefor is licensed under the BSD-2 Clause License as mentioned
 * [here](https://github.com/bitcoinjs/bip32/blob/master/LICENSE).
 *
 * @see https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki
 * @see https://github.com/satoshilabs/slips/blob/master/slip-0010.md
 * @see https://github.com/bitcoinjs/bip32
 * @see https://github.com/nemtech/NIP/issues/12
 * @since 0.2.0
 */
export class NodeEd25519 implements NodeInterface {

    /**
     * Hardened key derivation uses HIGHEST_BIT.
     *
     * @var number
     */
    public static readonly HIGHEST_BIT = 0x80000000;

    /**
     * Construct a `NodeEd25519` object.
     *
     * @param ___D      {Buffer|undefined}  The private key of the node.
     * @param ___Q      {Buffer|undefined}  The public key of the node.
     * @param chainCode {Buffer}            The chain code of the node (32 bytes).
     * @param network   {Network}           The network of the node, defaults to `Network.CATAPULT`.
     * @param ___DEPTH  {number}            The depth of the node (0 for master).
     * @param ___INDEX  {number}            The account index (0 for master).
     * @param ___PARENT_FINGERPRINT     {number}    The parent fingerprint (0x00000000 for master)
     */
    public constructor(
        private readonly __D: Buffer | undefined, // private Key
        private __Q: Buffer | undefined, // public Key
        public readonly chainCode: Buffer,
        public readonly network: Network = Network.CATAPULT,
        private readonly __DEPTH: number = 0,
        private readonly __INDEX: number = 0,
        private readonly __PARENT_FINGERPRINT: number = 0x00000000,
      ) {

    }

    /**
     * Create a hyper-deterministic ED25519 node from a
     * binary seed.
     *
     * @see https://github.com/bitcoinjs/bip32/blob/master/src/bip32.js#L258
     * @param   seed    {Buffer} 
     * @param   network {Network}
     * @return  {NodeInterface}
     */
    public static fromSeed(
        seed: Buffer,
        network: Network = Network.CATAPULT
    ): NodeInterface {

        if (seed.length < 16) throw new TypeError('Seed should be at least 128 bits');
        if (seed.length > 64) throw new TypeError('Seed should be at most 512 bits');

        //XXX keep "Bitcoin seed" for BIP32 compatibility ?
        const hmac = createHmac('sha512', Buffer.from('Catapult seed', 'utf8'));
        const I = hmac.update(seed).digest();
        const IL = I.slice(0, 32);
        const IR = I.slice(32);

        // IL = privateKey ; IR = chainCode
        return new NodeEd25519(IL, undefined, IR, network);
    }

    /**
     * Decode a base58 extended key payload into its'
     * `NodeEd25519` object representation.
     *
     * This method parses the base58 binary data and 
     * uses read fields to initialize a BIP32-ED25519
     * hyper-deterministic node.
     *
     * No ED25519 changes have been done here.
     *
     * @see https://github.com/bitcoinjs/bip32/blob/master/ts-src/bip32.ts#L286
     * @param   inString    {string}    The base58 payload of the extended key.
     * @param   network     {Network}   (Optional) The network of the key, default to `Network.CATAPULT`.
     * @return  {NodeEd25519}
     */
    public static fromBase58(
        inString: string,
        network: Network = Network.CATAPULT,
    ): NodeInterface {

        // decode base58
        const buffer = bs58check.decode(inString);
        if (buffer.length !== 78) {
            throw new TypeError('Base58 payload must be exactly 78 bytes, but got: ' + buffer.length + ' bytes.');
        }

        // 4 bytes: version bytes
        const version = buffer.readUInt32BE(0);
        if (version !== Network.CATAPULT.privateKeyPrefix
         && version !== Network.CATAPULT.publicKeyPrefix) {
            throw new TypeError('Payload Version must be one of: ' + Network.CATAPULT.privateKeyPrefix
                              + ' or ' + Network.CATAPULT.publicKeyPrefix + '.');
        }

        // 1 byte: depth: 0x00 for master nodes, 0x01 for level-1 descendants, ...
        const depth = buffer[4];

        // 4 bytes: the fingerprint of the parent's key (0x00000000 if master key)
        const parentFingerprint = buffer.readUInt32BE(5);

        // if depth is 0, parentFingerprint must be 0x00000000 (master node)
        if (depth === 0 && parentFingerprint !== 0x00000000) {
            throw new TypeError('Expected master node but got child with parentFingerprint: ' + parentFingerprint + '.');
        }

        // 4 bytes: child number. This is the number i in xi = xpar/i, with xi the key being serialized.
        // This is encoded in MSB order. (0x00000000 if master key)
        const index = buffer.readUInt32BE(9);

        // If depth is 0, index must also be 0 (master node)
        if (depth === 0 && index !== 0) {
            throw new TypeError('Expected index 0 with depth 0 but got index: ' + index + '.');
        }

        // 32 bytes: the chain code
        const chainCode = buffer.slice(13, 45);
        let hd: NodeInterface;

        if (version === Network.CATAPULT.privateKeyPrefix) {
        // 33 bytes: private key data (0x00 + k)

            if (buffer.readUInt8(45) !== 0x00) {
                throw new TypeError('Private key must start be prepended by 0x00.');
            }

            // extract private key (32 bytes)
            const k = buffer.slice(46, 78);

            // k = privateKey (createFromPrivateKey)
            hd = new NodeEd25519(k, undefined, chainCode, network, depth, index, parentFingerprint);

        } else {
        // 33 bytes: public key data (0x02 + X or 0x03 + X)

            // extract public key (33 bytes)
            const X = buffer.slice(45, 78);

            // X = publicKey
            hd = new NodeEd25519(undefined, X, chainCode, network, depth, index, parentFingerprint);
        }

        return hd;
    }

    /**
     * Getter for the `depth` of the key.
     *
     * @access private
     * @return {number}
     */
    private get depth(): number {
        return this.__DEPTH;
    }

    /**
     * Getter for the `index` (account index) of the key.
     *
     * @access private
     * @return {number}
     */
    private get index(): number {
        return this.__INDEX;
    }

    /**
     * Getter for the `parentFingerprint` parent fingerprint of the key.
     *
     * @access private
     * @return {number}
     */
    private get parentFingerprint(): number {
        return this.__PARENT_FINGERPRINT;
    }

    /**
     * Getter for the `publicKey` of the key.
     *
     * @access public
     * @return {Buffer}
     */
    public get publicKey(): Buffer {
        // if the publicKey is not set, derive from private key
        if (this.__Q === undefined) {
            this.__Q = Buffer.from(CatapultECC.extractPublicKey((this.__D as Buffer), Cryptography.sha3Hash));
        }

        return this.__Q!;
    }

    /**
     * Getter for the `privateKey` of the key.
     *
     * @access public
     * @return {Buffer}
     */
    public get privateKey(): Buffer {
        if (! this.__D) {
            throw new Error('Missing private key.');
        }

        return this.__D;
    }

    /**
     * Getter for the `identifier` of the key.
     *
     * The identifier is build as follows:
     * - Step 1: Sha3-256 of the public key
     * - Step 2: RIPEMD160 of the sha3 hash
     *
     * @access public
     * @return {Buffer}
     */
    public get identifier(): Buffer {
        return Cryptography.hash160(this.publicKey);
    }

    /**
     * Getter for the `fingerprint` of the key.
     *
     * The fingerprint are the first 4 bytes of the
     * identifier of the key.
     *
     * @access public
     * @return {Buffer}
     */
    public get fingerprint(): Buffer {
        return this.identifier.slice(0, 4);
    }

    /**
     * Return whether the node is neutered or not.
     *
     * Neutered keys = Extended Public Keys
     * Non-Neutered keys = Extended Private Keys 
     *
     * @access public
     * @return {Buffer}
     */
    public isNeutered(): boolean {
        return this.__D === undefined;
    }

    /**
     * Get the neutered node.
     *
     * @access public
     * @return {NodeInterface}
     */
    public neutered(): NodeInterface {
        return new NodeEd25519(
            undefined,
            this.publicKey,
            this.chainCode,
            this.network,
            this.depth,
            this.index,
            this.parentFingerprint,
        );
    }

    /**
     * Get the base58 representation of the node.
     *
     * When the node is neutered, this will return
     * an extended public key. When the node is not
     * neutered this will return an extended private
     * key.
     *
     * This method is copied AS IS from the `bitcoin/bip32`
     * package and provides a detailed implementation of the
     * base58 conversion process for extended keys.
     *
     * No ED25519 changes have been done here.
     *
     * @see https://github.com/bitcoinjs/bip32/blob/master/ts-src/bip32.ts#L129
     * @access public
     * @return {string}     The extended public or private key
     */
    public toBase58(): string {
        const network = this.network;
        const version = !this.isNeutered()
            ? Network.CATAPULT.privateKeyPrefix
            : Network.CATAPULT.publicKeyPrefix;
        const buffer = Buffer.allocUnsafe(78);

        // 4 bytes: version bytes
        buffer.writeUInt32BE(version, 0);

        // 1 byte: depth: 0x00 for master nodes, 0x01 for level-1 descendants, ....
        buffer.writeUInt8(this.depth, 4);

        // 4 bytes: the fingerprint of the parent's key (0x00000000 if master key)
        buffer.writeUInt32BE(this.parentFingerprint, 5);

        // 4 bytes: child number. This is the number i in xi = xpar/i, with xi the key being serialized.
        // This is encoded in big endian. (0x00000000 if master key)
        buffer.writeUInt32BE(this.index, 9);

        // 32 bytes: the chain code
        this.chainCode.copy(buffer, 13);

        // 33 bytes: the public key or private key data
        if (!this.isNeutered()) {
            // 0x00 + k for private keys
            buffer.writeUInt8(0, 45);
            this.privateKey!.copy(buffer, 46);

        // 33 bytes: the public key
        } else {
            // X9.62 encoding for public keys
            this.publicKey.copy(buffer, 45);
        }

        return bs58check.encode(buffer);
    }

    //XXX hidden usage of toHex() ?
    public toWIF(): string {
        throw new TypeError("Catapult BIP32 keys cannot be converted to WIF. Please use the toHex() method.");
    }

    /**
     * Generic child derivation.
     * 
     * This method reads the derivation paths and uses `derive`
     * and `deriveHardened` accordingly.
     *
     * Derivation paths starting with `m/` are only possible
     * with master nodes (for example created from seed).
     *
     * @param   index   {number}
     * @return  {NodeInterface}
     */
    public derivePath(
        path: string
    ): NodeInterface {
        if (! this.isValidPath(path)) {
            throw new TypeError('Invalid BIP32 derivation path provided.');
        }

        let splitPath = path.split('/');

        // check whether current node is a master node,
        // if not: "m/" derivation is not possible.
        if (splitPath[0] === 'm' && this.parentFingerprint) {
            throw new TypeError('Expected master node with "m" derivation, but got child with parentFingerprint.');
        }

        // drop first level path "m"
        if (splitPath[0] === 'm') {
            splitPath = splitPath.slice(1);
        }

        // apply derivation for each path level
        return splitPath.reduce(
            (prevHd, indexStr) => {
                let index;

                // determine whether hardened derivation is used or not
                if (indexStr.slice(-1) === `'`) {
                    // Hardened child key derivation
                    index = parseInt(indexStr.slice(0, -1), 10);
                    return prevHd.deriveHardened(index);
                } else {
                    // Normal child key derivation
                    index = parseInt(indexStr, 10);
                    return prevHd.derive(index);
                }
            },
            this as NodeInterface, // apply / bind interface
        );
    }

    /**
     * Hardened child derivation (derives private key).
     *
     * @internal Do not use this method directly, please use the `derivePath()` method instead.
     * @param   index   {number}
     * @return  {NodeInterface}
     */
    public deriveHardened(
        index: number
    ): NodeInterface {

        const UINT31_MAX = Math.pow(2, 31) - 1
        if (index > UINT31_MAX) {
            throw new TypeError('Hardened derivation maximum index overflow.');
        }

        // Only derives hardened private keys by default
        return this.derive(index + NodeEd25519.HIGHEST_BIT);
    }

    /**
     * Derive a child node with `index`.
     *
     * When the node is *not neutered*, an extended private
     * key will be created and when the node is *neutered*, 
     * an extended public key will be created.
     *
     * This method  is an overload of the `bitcoinjs/bip32`
     * package's `derive` method adapted to use *our* child
     * key derivation functions `CKDPriv` and `CKDPub`.
     *
     * @see https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki#child-key-derivation-ckd-functions
     * @internal Do not use this method directly, please use the `derivePath()` method instead.
     * @param   index   {number}
     * @return  {NodeInterface}
     */
    public derive(
        index: number
    ): NodeInterface {

        // check derivation validity
        const isHardened = index >= NodeEd25519.HIGHEST_BIT;
        if (isHardened && this.isNeutered()) {
            throw new TypeError('Missing private key for hardened child key derivation.');
        }

        // Parent key is current node
        const parentKey = this;

        if (! this.isNeutered()) {
        // (1) Private parent key -> private child key

            // use ED25519-adapted child key derivation function
            return CKDPriv(parentKey, index);
        }

        // (2) Public parent key -> public child key

        // use ED25519-adapted child key derivation function
        return CKDPub(parentKey, index);
    }

    /**
     * Sign binary data with current node.
     *
     * Overloads the `bitcoinjs/bip32` method named `sign` in order to
     * be ED25519 compliant and use `CatapultECC` with ed25519 instead
     * of secp256k1.
     *
     * @see https://github.com/bitcoinjs/bip32/blob/master/ts-src/bip32.ts#L277
     * @param   hash    {Buffer}    The binary data to sign.
     * @param   length  {number}    (Optional) The byte size of the produced SHA3 hash, defaults to 64
     * @return  {NodeInterface}
     */
    public sign(
        hash: Buffer,
        length: number = 64
    ): Buffer {
        const secretKey = this.privateKey as Buffer;
        const hasher = Cryptography.createSha3Hasher(64);
        const signature = CatapultECC.sign(hash, this.publicKey, secretKey, hasher);

        return Buffer.from(signature);
    }

    /**
     * Verify a signature `signature` for data
     * `hash` with the current node.
     * 
     * Overloads the `bitcoinjs/bip32` method named `verify` in order to
     * be ED25519 compliant and use `CatapultECC` with ed25519 instead
     * of secp256k1.
     *
     * @see https://github.com/bitcoinjs/bip32/blob/master/ts-src/bip32.ts#L281
     * @param   hash        {Buffer}    The binary data that was supposedly signed.
     * @param   signature   {Buffer}    The signature binary data that needs to be verified.
     * @return  {boolean}   Returns true for a valid signature, false otherwise.
     */
    public verify(
        hash: Buffer,
        signature: Buffer
    ): boolean {
        const length = signature.byteLength === 32 ? 32 : 64;
        const hasher = Cryptography.createSha3Hasher(length);
        return CatapultECC.verify(hash, this.publicKey, signature, hasher);
    }

    /**
     * Validate a BIP32/BIP44 path by regular expression.
     *
     * @see https://github.com/bitcoinjs/bip32/blob/master/src/bip32.js#L26
     * @param   path    {string}
     * @return  {boolean}
     */
    protected isValidPath(
        path: string
    ): boolean {
        return path.match(/^(m\/)?(\d+'?\/)*\d+'?$/) !== null;
    }
}