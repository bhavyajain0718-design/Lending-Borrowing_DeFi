import { ProtectionDashboard } from "../components/ProtectionDashboard";

const lendingAddress = process.env.NEXT_PUBLIC_LENDING_ADDRESS;
const homeownerAddress = process.env.NEXT_PUBLIC_HOMEOWNER_ADDRESS;
const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

export default function Page() {
  return (
    <main>
      <ProtectionDashboard
        lendingAddress={lendingAddress}
        homeownerAddress={homeownerAddress}
        rpcUrl={rpcUrl}
      />
    </main>
  );
}
