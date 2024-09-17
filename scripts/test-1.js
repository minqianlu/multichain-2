const { Near, KeyPair, keyStores, connect, transactions, utils, Account } = require("near-api-js");
const path = require("path");
const { homedir } = require("os");
const { ethers } = require("ethers");
const { encode } = require("@ethersproject/rlp");
const { BN } = require("bn.js");
const Ethereum = require("../services/ethereum.js")
const { base_decode } = require('near-api-js/lib/utils/serialize');
const { parseNearAmount } = require("near-api-js/lib/utils/format");
const { bytesToHex } = require("@ethereumjs/util");

// MPC Constants
const MPC = "v1.signer-prod.testnet";
const PATH = "my-first-eth-key";
const CHAIN_ID = 84532; // 97 bsc testnet
const CHAIN_RPC = "https://sepolia.base.org"

// NEAR Constants
const ACCOUNT_ID = "minqi.testnet";
const network = "testnet";
const CREDENTIALS_DIR = ".near-credentials";
const CREDENTIALSPATH = path.join(homedir(), CREDENTIALS_DIR);

// Contract Constants TODO: UPDATE
const abi = [
    "function storeMessage(string newMessage)"
];

async function setupNear() {
    let keyStore = new keyStores.UnencryptedFileSystemKeyStore(CREDENTIALSPATH);

    let nearConfig = {
        networkId: network,
        keyStore: keyStore,
        nodeUrl: `https://rpc.${network}.near.org`,
        walletUrl: `https://wallet.${network}.near.org`,
        helperUrl: `https://helper.${network}.near.org`,
        explorerUrl: `https://explorer.${network}.near.org`,
    };

    let near = new Near(nearConfig);
    return near;
}

async function getInfo() {
    const ETH = new Ethereum(CHAIN_RPC, CHAIN_ID);
    let { publicKey, address } = await ETH.deriveAddress(ACCOUNT_ID, PATH);
    let publicKeyString = publicKey.toString('hex')
    console.log(`derived public key: ${publicKeyString}`);
    console.log(`derived address: ${address}`);
    return { publicKey, publicKeyString, address}
}

async function sendMessage(message){
    const near = await setupNear();
    const account = new Account(near.connection, ACCOUNT_ID);
    const ETH = new Ethereum(CHAIN_RPC, CHAIN_ID);

    let { publicKey, publicKeyString, address } = await getInfo();
    let payload;

    const nonce = await ETH.provider.getTransactionCount(address)
    // Create an instance of ethers.Interface using the ABI
    const iface = new ethers.utils.Interface(abi);

    // Encode the method and its parameters
    const methodData = iface.encodeFunctionData("storeMessage", [message]);

    const transaction = {
        to: "0x7E3192C399b06A547fB3C849aFb6E79Bf9EDBAd1",
        gasLimit: 40000,
        chainId: CHAIN_ID,
        nonce,
        maxPriorityFeePerGas: ethers.utils.parseUnits("2", "gwei"), 
        maxFeePerGas: ethers.utils.parseUnits("100", "gwei"), 
        value: ethers.utils.parseEther("0.0001"),
        data: methodData,
        type: 2,
        accessList: [],
    }

    // ~~~~~~~~~~~~~ MPC SIGNING ~~~~~~~~~~~~~
    try{
        const unsignedTx = ethers.utils.serializeTransaction(transaction);
        const txHash = ethers.utils.keccak256(unsignedTx);
        payload = Object.values(ethers.utils.arrayify(txHash));
    }catch(e){
        console.log("error creating payload: ", e)
    }

    // console.log("payload: ", payload)
    let result;
    try{
        result = await account.functionCall({ 
            contractId: MPC, 
            methodName: 'sign', 
            args: { 
                request: { 
                    payload, 
                    path: PATH, 
                    key_version: 0 
                } 
            }, 
            gas: '300000000000000', 
            attachedDeposit: parseNearAmount('0.5') 
        });
    }catch(e){
        console.log("error signing: ", e)
    }

    const sigBase64 = Buffer.from(result.status.SuccessValue, 'base64').toString('utf-8');
    const sigJSON = JSON.parse(sigBase64);
    const sigRes = [sigJSON.big_r.affine_point, sigJSON.s.scalar, sigJSON.recovery_id]
    console.log("signature: ", sigRes)

    // ~~~~~~~~~~~~~ RECONSTRUCT SIGNATURE AND BROADCAST ~~~~~~~~~~~~~
    try{
        sig = {
            r: "0x" + sigRes[0].substring(2).toLowerCase(),
            s: "0x" + sigRes[1].toLowerCase(),
            v: sigRes[2],
          };
          let addressRecovered = false;
          for (let v = 0; v < 2; v++) {
            sig.v = v + CHAIN_ID * 2 + 35;
            const recoveredAddress = ethers.utils
              .recoverAddress(payload, sig)
              .toLowerCase();
            if (recoveredAddress === address) {
              addressRecovered = true;
              break;
            }
          }

          if (!addressRecovered) {
            console.log("signature failed to recover to correct address");
            return;
          }
    }catch(e){
        console.log("error reconstructing signature: ", e)
    }

    const signedTx = ethers.utils.serializeTransaction(transaction, sig);
    console.log("signed tx", signedTx);

    try{
        const relayed = await ETH.provider.sendTransaction(signedTx)
        return relayed.transactionHash
    }catch(e){
        console.log("error relaying transaction: ", e)
    }
}

sendMessage("Hello from NEAR MPC!")
