/**
 * Every value given for a repeated flag, read from raw argv.
 *
 * citty keeps only the last occurrence of a flag — `--x a --x b` parses to
 * `"b"` — so a repeated `--exclude` would silently drop all but the final
 * pattern. Collecting from rawArgs is the documented workaround
 * (unjs/citty#258 proposes a `multiple` modifier that would remove the need).
 */
export function collectRepeated(rawArgs: string[], name: string): string[] {
  const values: string[] = [];

  for (let index = 0; index < rawArgs.length; index++) {
    const argument = rawArgs[index];
    if (argument === undefined) continue;

    if (argument === `--${name}`) {
      const next = rawArgs[index + 1];
      // A following flag means this occurrence had no value.
      if (next !== undefined && !next.startsWith("-")) {
        values.push(next);
        index++;
      }
      continue;
    }

    if (argument.startsWith(`--${name}=`)) {
      values.push(argument.slice(`--${name}=`.length));
    }
  }

  return values;
}
