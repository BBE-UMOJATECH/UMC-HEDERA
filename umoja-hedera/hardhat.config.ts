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
      // rpc-amoy.polygon.technology stopped resolving; publicnode is the fallback.
      url:
        process.env.POLYGON_RPC_URL ||
        "https://polygon-amoy-bor-rpc.publicnode.com",
      accounts: process.env.POLYGON_RELAYER_PRIVATE_KEY
        ? [process.env.POLYGON_RELAYER_PRIVATE_KEY]
        : [],
      chainId: 80002,
    },
    polygon: {
      // No public fallback on purpose: mainnet gets a paid, dedicated endpoint
      // or nothing. Public RPCs rate-limit and disappear (see Amoy above).
      url: process.env.POLYGON_MAINNET_RPC_URL || "",
      accounts: process.env.POLYGON_RELAYER_PRIVATE_KEY
        ? [process.env.POLYGON_RELAYER_PRIVATE_KEY]
        : [],
      chainId: 137,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  // Hedera (chain 296/295) isn't a supported Etherscan network; verify via
  // Sourcify pointed at HashScan's own server (also avoids sourcify.dev brownouts).
  etherscan: {
    enabled: false,
  },
  sourcify: {
    enabled: true,
    apiUrl: "https://server-verify.hashscan.io",
    browserUrl: "https://repository-verify.hashscan.io",
  },
};

export default config;
