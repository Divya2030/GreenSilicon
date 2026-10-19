import { createContext, useContext } from "react";
import type { AppConfig } from "./types";

export const ConfigContext = createContext<AppConfig | null>(null);
export const useConfig = () => useContext(ConfigContext);

export function actorName(cfg: AppConfig | null, address: string): string {
  if (!cfg) return address;
  const a = Object.values(cfg.actors).find((x) => x.address.toLowerCase() === address.toLowerCase());
  return a ? a.name : address;
}
