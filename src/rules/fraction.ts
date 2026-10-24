/**
 * Exact rational numbers on bigint, so a fare is computed without float error until it is rounded, exactly like
 * the contract's reference engine (reference_check.py uses Python's Fraction).
 */
export class Frac {
  private constructor(
    readonly n: bigint,
    readonly d: bigint,
  ) {}

  static of(n: bigint | number, d: bigint | number = 1n): Frac {
    let num = BigInt(n);
    let den = BigInt(d);
    if (den === 0n) throw new Error("division by zero");
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num < 0n ? -num : num, den);
    return new Frac(num / g, den / g);
  }

  /** From a decimal number the way it is written (3.2 → 16/5), never through binary floating point. */
  static dec(value: number | string): Frac {
    const text = typeof value === "number" ? numberText(value) : value.trim();
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) throw new Error(`Not a decimal number: ${text}`);
    const [, sign, whole, fraction = ""] = match;
    const n = BigInt(`${whole}${fraction}`) * (sign === "-" ? -1n : 1n);
    return Frac.of(n, 10n ** BigInt(fraction.length));
  }

  static readonly ZERO = Frac.of(0);
  static readonly ONE = Frac.of(1);

  add(o: Frac): Frac {
    return Frac.of(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o: Frac): Frac {
    return Frac.of(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o: Frac): Frac {
    return Frac.of(this.n * o.n, this.d * o.d);
  }
  div(o: Frac): Frac {
    return Frac.of(this.n * o.d, this.d * o.n);
  }
  cmp(o: Frac): number {
    const left = this.n * o.d;
    const right = o.n * this.d;
    return left < right ? -1 : left > right ? 1 : 0;
  }
  isZero(): boolean {
    return this.n === 0n;
  }
  /** floor(x + 1/2): a tie goes up, toward +∞, also for a negative value (contract.json#pricing.halfUp). */
  halfUp(): bigint {
    return floorDiv(2n * this.n + this.d, 2n * this.d);
  }
  static max(a: Frac, b: Frac): Frac {
    return a.cmp(b) >= 0 ? a : b;
  }
  static min(a: Frac, b: Frac): Frac {
    return a.cmp(b) <= 0 ? a : b;
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q;
}

function numberText(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Not a finite number: ${value}`);
  // Shortest round-trip text; expand exponent forms like 1e-7.
  const text = String(value);
  if (!/e/i.test(text)) return text;
  return value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
}
