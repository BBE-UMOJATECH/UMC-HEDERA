/**
 * Verify Hedera contracts against the Sourcify v2 API.
 *
 * The bundled hardhat-verify (2.1.3) speaks only the Sourcify v1 API, which is
 * being sunset (and is in a brownout window). HashScan reads from Sourcify, so
 * we submit the standard-JSON input straight to the v2 endpoint instead.
 */
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

const SERVER = "https://sourcify.dev/server";

//   npx ts-node scripts/verifySourcifyV2.ts            → Hedera (default)
//   npx ts-node scripts/verifySourcifyV2.ts polygon    → Polygon
const TARGET = (process.argv[2] || "hedera").toLowerCase();

// Follows HEDERA_NETWORK / POLYGON_CHAIN_ID, the same switches the deploy
// scripts use, so verifying cannot target a different network than the
// artifacts being read.
const NET = process.env.HEDERA_NETWORK === "mainnet" ? "mainnet" : "testnet";

const CHAIN_ID =
  TARGET === "polygon"
    ? Number(process.env.POLYGON_CHAIN_ID) || 137
    : NET === "mainnet"
      ? 295
      : 296;

const RPC_URL =
  TARGET === "polygon"
    ? CHAIN_ID === 137
      ? process.env.POLYGON_MAINNET_RPC_URL!
      : process.env.POLYGON_RPC_URL!
    : NET === "mainnet"
      ? process.env.HEDERA_MAINNET_RPC || "https://mainnet.hashio.io/api"
      : process.env.HEDERA_TESTNET_RPC || "https://testnet.hashio.io/api";
const IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const OZ_PROXY_BUILD_INFO = path.join(
  __dirname,
  "../node_modules/@openzeppelin/upgrades-core/artifacts/build-info-v5.json"
);

interface Target {
  address: string;
  contractIdentifier: string;
  buildInfo: string;
  compiler: string;
}

/**
 * Follow hardhat's own artifact → build-info pointer rather than pinning a
 * hash. The hash changes on every recompile, and a stale one silently submits
 * the wrong sources.
 */
function buildInfoFor(contract: string): string {
  const dbgPath = path.join(
    __dirname,
    `../artifacts/contracts/${contract}.sol/${contract}.dbg.json`
  );
  const dbg = JSON.parse(fs.readFileSync(dbgPath, "utf-8"));
  return path.resolve(path.dirname(dbgPath), dbg.buildInfo);
}

function compilerFor(buildInfo: string): string {
  return JSON.parse(fs.readFileSync(buildInfo, "utf-8")).solcLongVersion;
}

function implTarget(contract: string, address: string): Target {
  const buildInfo = buildInfoFor(contract);
  return {
    address,
    contractIdentifier: `contracts/${contract}.sol:${contract}`,
    buildInfo,
    compiler: compilerFor(buildInfo),
  };
}

function proxyTarget(address: string): Target {
  return {
    address,
    contractIdentifier:
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
    buildInfo: OZ_PROXY_BUILD_INFO,
    compiler: compilerFor(OZ_PROXY_BUILD_INFO),
  };
}

/** Read the ERC-1967 implementation slot so impl addresses are never hand-copied. */
async function implementationOf(proxy: string): Promise<string> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getStorageAt",
      params: [proxy, IMPL_SLOT, "latest"],
    }),
  });
  const data = (await res.json()) as { result?: string };
  if (!data.result) throw new Error(`Could not read impl slot of ${proxy}`);
  return `0x${data.result.slice(-40)}`;
}

async function buildTargets(): Promise<Target[]> {
  const read = (f: string) =>
    JSON.parse(fs.readFileSync(path.join(__dirname, `../deployments/${f}`), "utf-8"));

  // Polygon deploys token and bridge from one script into one artifact; Hedera
  // uses two, and stores the token address unprefixed.
  let tokenProxy: string;
  let bridgeProxy: string;
  let bridgeContract: string;

  if (TARGET === "polygon") {
    const d = read(CHAIN_ID === 137 ? "polygon-bridge-mainnet.json" : "polygon-bridge-amoy.json");
    tokenProxy = d.umcToken;
    bridgeProxy = d.bridgeAddress;
    bridgeContract = "UMCBridgePolygon";
  } else {
    tokenProxy = `0x${read(`${NET}.json`).evmAddress.replace(/^0x/, "")}`;
    bridgeProxy = read(`hedera-bridge-${NET}.json`).bridgeAddress;
    bridgeContract = "UMCBridgeHedera";
  }

  return [
    implTarget("UMCToken", await implementationOf(tokenProxy)),
    implTarget(bridgeContract, await implementationOf(bridgeProxy)),
    proxyTarget(tokenProxy),
    proxyTarget(bridgeProxy),
  ];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function alreadyVerified(address: string): Promise<boolean> {
  const res = await fetch(`${SERVER}/v2/contract/${CHAIN_ID}/${address}`);
  if (!res.ok) return false;
  const data: any = await res.json();
  return Boolean(data.match || data.runtimeMatch || data.creationMatch);
}

async function verify(t: Target): Promise<void> {
  console.log(`\n▶ ${t.contractIdentifier}\n  ${t.address}`);

  if (await alreadyVerified(t.address)) {
    console.log("  ✅ already verified on Sourcify");
    return;
  }

  const stdJsonInput = JSON.parse(fs.readFileSync(t.buildInfo, "utf-8")).input;
  const res = await fetch(`${SERVER}/v2/verify/${CHAIN_ID}/${t.address}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stdJsonInput,
      compilerVersion: t.compiler,
      contractIdentifier: t.contractIdentifier,
    }),
  });

  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log(`  ❌ submit failed (${res.status}): ${JSON.stringify(body)}`);
    return;
  }

  const verificationId = body.verificationId;
  console.log(`  ⏳ job ${verificationId} — polling...`);

  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const jr = await fetch(`${SERVER}/v2/verify/${verificationId}`);
    const job: any = await jr.json();
    if (job.isJobCompleted) {
      if (job.error) {
        console.log(`  ❌ ${job.error.customCode || ""}: ${job.error.message}`);
      } else {
        const m = job.contract || {};
        console.log(
          `  ✅ verified — match=${m.match} runtime=${m.runtimeMatch} creation=${m.creationMatch}`
        );
        console.log(
          `  🔗 https://repo.sourcify.dev/${CHAIN_ID}/${t.address}`
        );
      }
      return;
    }
  }
  console.log("  ⚠ timed out waiting for job completion");
}

async function main() {
  for (const t of await buildTargets()) {
    await verify(t);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
