import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import * as dotenv from "dotenv";

dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
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
    polygonAmoy: {
      url: process.env.POLYGON_RPC_URL || "https://rpc-amoy.polygon.technology",
      accounts: process.env.POLYGON_RELAYER_PRIVATE_KEY
        ? [process.env.POLYGON_RELAYER_PRIVATE_KEY]
        : [],
      chainId: 80002,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  sourcify: {
    enabled: true,
  },
};

export default config;
