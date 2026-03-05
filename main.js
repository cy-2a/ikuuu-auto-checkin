import { appendFileSync } from "fs";

// ==================== 配置区 ====================
const CONFIG = {
  host: process.env.HOST || "ikuuu.nl",
  timeout: 30000, // 请求超时 30 秒
  retryTimes: 3, // 重试次数
  retryDelay: 2000, // 重试延迟 2 秒
  concurrentLimit: 3, // 并发限制,避免服务器压力
  notifyApi: "https://api.chuckfang.com/第五个季节/",
};

const logInUrl = `https://${CONFIG.host}/auth/login`;
const checkInUrl = `https://${CONFIG.host}/user/checkin`;

// ==================== 工具函数 ====================

// 延迟函数
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 带超时的 fetch
async function fetchWithTimeout(url, options = {}, timeout = CONFIG.timeout) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      throw new Error(`请求超时 (${timeout}ms)`);
    }
    throw error;
  }
}

// 带重试的请求
async function fetchWithRetry(url, options = {}, retryCount = 0) {
  try {
    return await fetchWithTimeout(url, options);
  } catch (error) {
    if (retryCount < CONFIG.retryTimes) {
      console.log(
        `请求失败,${CONFIG.retryDelay / 1000}秒后进行第 ${retryCount + 1} 次重试...`
      );
      await sleep(CONFIG.retryDelay);
      return fetchWithRetry(url, options, retryCount + 1);
    }
    throw error;
  }
}

// 优化的 Cookie 格式化
function formatCookie(rawCookieArray) {
  if (!rawCookieArray || rawCookieArray.length === 0) {
    return "";
  }

  const cookieMap = new Map();

  for (const cookieString of rawCookieArray) {
    // 更严格的 Cookie 解析
    const parts = cookieString.split(";")[0].trim();
    const [key, ...valueParts] = parts.split("=");
    if (key) {
      cookieMap.set(key.trim(), valueParts.join("=").trim());
    }
  }

  return Array.from(cookieMap, ([k, v]) => `${k}=${v}`).join("; ");
}

// 设置 GitHub Actions 输出
function setGitHubOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    try {
      appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<EOF\n${value}\nEOF\n`);
    } catch (error) {
      console.error("写入 GitHub Output 失败:", error.message);
    }
  }
}

// 发送结果到自定义 API
async function sendNotification(message) {
  if (!CONFIG.notifyApi) {
    return;
  }

  try {
    // URL 编码消息内容
    const encodedMessage = encodeURIComponent(message);
    const notifyUrl = `${CONFIG.notifyApi}${encodedMessage}`;

    console.log(`\n发送通知到: ${CONFIG.notifyApi}`);

    const response = await fetchWithTimeout(
      notifyUrl,
      {
        method: "GET",
        headers: {
          "User-Agent": "IKUUU-Auto-Checkin/1.0",
        },
      },
      10000 // 通知请求 10 秒超时
    );

    if (response.ok) {
      console.log("✅ 通知发送成功");
    } else {
      console.warn(`⚠️ 通知发送失败: HTTP ${response.status}`);
    }
  } catch (error) {
    console.error(`❌ 通知发送异常: ${error.message}`);
    // 通知失败不影响主流程
  }
}

// ==================== 核心业务逻辑 ====================

// 登录获取 Cookie
async function logIn(account) {
  console.log(`\n[${account.name}] 开始登录...`);

  try {
    const formData = new FormData();
    formData.append("email", account.email);
    formData.append("passwd", account.passwd);
    formData.append("code", "");

    const response = await fetchWithRetry(logInUrl, {
      method: "POST",
      body: formData,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} - ${response.statusText}`);
    }

    const responseJson = await response.json();

    if (responseJson.ret !== 1) {
      throw new Error(responseJson.msg || "登录失败,未知错误");
    }

    console.log(`[${account.name}] ${responseJson.msg}`);

    const rawCookieArray = response.headers.getSetCookie();
    const cookie = formatCookie(rawCookieArray);

    if (!cookie) {
      throw new Error("获取 Cookie 失败,可能是账号密码错误");
    }

    return { ...account, cookie };
  } catch (error) {
    throw new Error(`登录失败: ${error.message}`);
  }
}

// 签到
async function checkIn(account) {
  console.log(`[${account.name}] 开始签到...`);

  try {
    const response = await fetchWithRetry(checkInUrl, {
      method: "POST",
      headers: {
        Cookie: account.cookie,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} - ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.msg) {
      throw new Error("签到响应格式异常");
    }

    console.log(`[${account.name}] ${data.msg}`);
    return data.msg;
  } catch (error) {
    throw new Error(`签到失败: ${error.message}`);
  }
}

// 处理单个账户
async function processSingleAccount(account) {
  try {
    const cookedAccount = await logIn(account);
    await sleep(1000); // 登录和签到之间间隔 1 秒
    const checkInResult = await checkIn(cookedAccount);
    return {
      success: true,
      name: account.name,
      message: checkInResult,
    };
  } catch (error) {
    console.error(`[${account.name}] ❌ ${error.message}`);
    return {
      success: false,
      name: account.name,
      message: error.message,
    };
  }
}

// 并发控制处理多个账户
async function processAccountsWithLimit(accounts, limit = CONFIG.concurrentLimit) {
  const results = [];
  const executing = [];

  for (const account of accounts) {
    const promise = processSingleAccount(account).then((result) => {
      executing.splice(executing.indexOf(promise), 1);
      return result;
    });

    results.push(promise);
    executing.push(promise);

    if (executing.length >= limit) {
      await Promise.race(executing);
    }

    // 账户之间间隔 500ms,避免请求过快
    await sleep(500);
  }

  return Promise.all(results);
}

// ==================== 主函数 ====================

async function main() {
  console.log("========================================");
  console.log("🚀 IKUUU 自动签到脚本启动");
  console.log(`⏰ 执行时间: ${new Date().toLocaleString("zh-CN")}`);
  console.log(`🌐 目标站点: ${CONFIG.host}`);
  console.log("========================================");

  let accounts;

  // 验证和解析账户信息
  try {
    if (!process.env.ACCOUNTS) {
      throw new Error("未配置 ACCOUNTS 环境变量");
    }

    accounts = JSON.parse(process.env.ACCOUNTS);

    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error("账户列表为空或格式错误");
    }

    // 验证账户格式
    for (const account of accounts) {
      if (!account.name || !account.email || !account.passwd) {
        throw new Error(
          `账户配置不完整: ${JSON.stringify(account)}`
        );
      }
    }

    console.log(`\n📋 共加载 ${accounts.length} 个账户\n`);
  } catch (error) {
    const errorMsg = `❌ 配置错误: ${error.message}`;
    console.error(errorMsg);
    setGitHubOutput("result", errorMsg);
    await sendNotification(errorMsg);
    process.exit(1);
  }

  // 执行签到
  let results;
  try {
    results = await processAccountsWithLimit(accounts);
  } catch (error) {
    const errorMsg = `❌ 执行异常: ${error.message}`;
    console.error(errorMsg);
    setGitHubOutput("result", errorMsg);
    await sendNotification(errorMsg);
    process.exit(1);
  }

  // 生成结果报告
  console.log("\n========================================");
  console.log("📊 签到结果汇总");
  console.log("========================================\n");

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.length - successCount;

  const resultLines = results.map((result) => {
    const icon = result.success ? "✅" : "❌";
    const line = `${result.name}: ${icon} ${result.message}`;
    console.log(line);
    return line;
  });

  const summary = `\n📈 成功: ${successCount} | 失败: ${failCount} | 总计: ${results.length}`;
  console.log(summary);

  const fullResult = resultLines.join("\n") + summary;

  // 输出结果
  setGitHubOutput("result", fullResult);

  // 发送通知
  await sendNotification(fullResult);

  console.log("\n========================================");
  console.log("✨ 脚本执行完成");
  console.log("========================================");

  // 如果有失败的账户,退出码为 1
  if (failCount > 0) {
    process.exit(1);
  }
}

// 全局错误处理
process.on("unhandledRejection", (error) => {
  console.error("❌ 未处理的 Promise 错误:", error);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("❌ 未捕获的异常:", error);
  process.exit(1);
});

// 启动
main();
