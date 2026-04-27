import { ethers } from "ethers";

export interface TokenBalance {
  symbol: string;
  address: string;
  decimals: number;
  balance: string;
}

export interface WalletSnapshot {
  address: string;
  ethBalanceEth: string;
  tokens: TokenBalance[];
  capturedAt: number;
}

const ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)"];

export async function readWalletSnapshot(
  rpcUrl: string,
  address: string,
  tokens: Array<{ symbol: string; address: string; decimals: number }>
): Promise<WalletSnapshot> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const [rawEth, ...rawTokens] = await Promise.all([
    provider.getBalance(address),
    ...tokens.map(async (t) => {
      const contract = new ethers.Contract(t.address, ERC20_ABI, provider);
      const raw = await (contract.balanceOf(address) as Promise<bigint>);
      return { ...t, balance: ethers.formatUnits(raw, t.decimals) };
    }),
  ]);

  return {
    address,
    ethBalanceEth: ethers.formatEther(rawEth as bigint),
    tokens: rawTokens.filter((t) => parseFloat(t.balance) > 0),
    capturedAt: Date.now(),
  };
}
