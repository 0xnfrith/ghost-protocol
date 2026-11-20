// The output rules of the plugin interface (interface 1): the first line is
// GP_INTERFACE=1; a GP_<KEY>=<value> line on stdout is for the plugin; every
// other line is for people and goes to stderr; a failure ends with
// GP_ERROR=<code> and GP_ERROR_MESSAGE=<one line>, and a non-zero exit.
export const INTERFACE = 1;

export class GpError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function makeOut(stdout = process.stdout, stderr = process.stderr) {
  const oneLine = (s) => String(s).replace(/[\r\n]+/g, " ").trim();
  let headed = false;
  const header = () => {
    if (!headed) stdout.write(`GP_INTERFACE=${INTERFACE}\n`);
    headed = true;
  };
  return {
    header,
    kv: (key, value) => stdout.write(`GP_${key}=${oneLine(value)}\n`),
    log: (line) => stderr.write(`${oneLine(line)}\n`),
    raw: (s) => stdout.write(s),
    error: (code, message) => {
      header();
      stdout.write(`GP_ERROR=${code}\n`);
      stdout.write(`GP_ERROR_MESSAGE=${oneLine(message)}\n`);
    },
  };
}
