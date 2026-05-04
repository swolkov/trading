"use client";

import { useState, useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";

interface Asset {
  symbol: string;
  name: string;
}

interface SymbolSearchProps {
  onSelect: (symbol: string) => void;
  value?: string;
}

export function SymbolSearch({ onSelect, value }: SymbolSearchProps) {
  const [query, setQuery] = useState(value || "");
  const [results, setResults] = useState<Asset[]>([]);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (value) setQuery(value);
  }, [value]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function handleChange(val: string) {
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (val.length < 1) {
      setResults([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const res = await fetch(`/api/search?q=${encodeURIComponent(val)}`);
      const data = await res.json();
      setResults(data);
      setOpen(true);
    }, 300);
  }

  return (
    <div ref={containerRef} className="relative">
      <Input
        placeholder="Search symbol (e.g. AAPL)"
        value={query}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
      />
      {open && results.length > 0 && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-popover border rounded-md shadow-md max-h-60 overflow-auto">
          {results.map((asset) => (
            <button
              key={asset.symbol}
              className="w-full text-left px-3 py-2 hover:bg-accent text-sm flex justify-between"
              onClick={() => {
                setQuery(asset.symbol);
                setOpen(false);
                onSelect(asset.symbol);
              }}
            >
              <span className="font-medium">{asset.symbol}</span>
              <span className="text-muted-foreground truncate ml-2">
                {asset.name}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
