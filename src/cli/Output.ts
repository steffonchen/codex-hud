import { t } from "../i18n/Messages.js";
export function writeOutput(output: NodeJS.WritableStream, text: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output.off("close", closed);
      reject(new Error(t("终端输出失败：{0}", error.message), { cause: error }));
      // Writable 可能先调用写入回调，再发出 error；保留监听器接住该事件。
      setImmediate(() => output.off("error", fail));
    };
    const closed = () => fail(new Error(t("输出流已关闭")));
    const timer = setTimeout(() => {
      const error = new Error(t("输出流在限定时间内未完成写入"));
      // 超时后取消真实 Writable；否则迟到的写入失败可能在监听释放后变成未捕获异常。
      try { (output as NodeJS.WritableStream & { destroy?: () => void }).destroy?.(); }
      catch (cause) { error.cause = cause; }
      fail(error);
    }, timeoutMs);
    output.once("error", fail);
    output.once("close", closed);
    try {
      output.write(text, (error?: Error | null) => {
        if (error) {
          fail(error);
        } else if (!settled) {
          settled = true;
          clearTimeout(timer);
          output.off("error", fail);
          output.off("close", closed);
          resolve();
        }
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
