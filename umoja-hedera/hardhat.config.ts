import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import * as dotenv from "dotenv";

dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "shanghai",
    },
  },
  networks: {
    hederaTestnet: {
      url: process.env.HEDERA_TESTNET_RPC || "https://testnet.hashio.io/api",
      accounts: process.env.HEDERA_OPERATOR_KEY_HEX
        ? [process.env.HEDERA_OPERATOR_KEY_HEX]
        : [],
      chainId: 296,
    },
    hederaMainnet: {
      url: process.env.HEDERA_MAINNET_RPC || "https://mainnet.hashio.io/api",
      accounts: process.env.HEDERA_OPERATOR_KEY_HEX
        ? [process.env.HEDERA_OPERATOR_KEY_HEX]
        : [],
      chainId: 295,
    },
    hederaLocal: {
      url: "http://localhost:7546",
      accounts: [
        "0x105d050185ccb907fba04dd92d8de9e32c18305e097ab41dadda21489a211524",
      ],
      chainId: 298,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
