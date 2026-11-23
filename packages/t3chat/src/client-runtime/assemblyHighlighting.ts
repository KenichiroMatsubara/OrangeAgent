// FlareChat: from the main entry; the subpath exists only in t3code's patched @pierre/diffs.
import { setCustomExtension } from "@pierre/diffs";

// The default .s mapping is riscv, which the Highlights backend does not support.
for (const extension of ["asm", "ASM", "s", "S", "nasm", "NASM"]) {
  setCustomExtension(extension, "asm");
}
