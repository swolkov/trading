"use client";

import { useState } from "react";
import { SymbolSearch } from "@/components/trading/symbol-search";
import { Button } from "@/components/ui/button";

interface AddSymbolProps {
  onAdded: () => void;
}

export function AddSymbol({ onAdded }: AddSymbolProps) {
  const [symbol, setSymbol] = useState("");
  const [adding, setAdding] = useState(false);

  async function handleAdd() {
    if (!symbol) return;
    setAdding(true);
    try {
      await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      setSymbol("");
      onAdded();
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="flex gap-2 items-end">
      <div className="w-64">
        <SymbolSearch onSelect={setSymbol} value={symbol} />
      </div>
      <Button onClick={handleAdd} disabled={!symbol || adding}>
        {adding ? "Adding..." : "Add to Watchlist"}
      </Button>
    </div>
  );
}
