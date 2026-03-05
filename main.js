import { fetch, FormData } from "undici";
import { appendFileSync } from "fs";

const host = process.env.HOST || "ikuuu.nl";

const logInUrl = `https://${host}/auth/login`;
const checkInUrl = `https://${host}/user/checkin`;

const API_BASE = "https://api.chuckfang.com/第五个季节/";

// 格式化 Cookie
function formatCookie(rawCookieArray) {
  const cookiePairs = new Map();

  for (const cookieString of rawCookieArray) {
    const match = cookieString.match(/^\s*([^=]+)=([^;]*)/);

    if (match) {
      cookiePairs.set(match[1].trim(), match[2].trim());
    }
  }

  return Array.from(cookiePairs)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

// 登录
async function logIn(account) {
  console.log(`${account.name}: 登录中...`);

  try {
    const formData = new FormData();

    formData.append("host", host);
    formData.append("email", account.email);
    formData.append("passwd", account.passwd);
    formData.append("code", "");
    formData.append("remember_me", "off");

    const response = await fetch(logInUrl, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`网络错误 ${response.status}`);
    }

    const data = await response.json();

    if (data.ret !== 1) {
      throw new Error(data.msg || "登录失败");
    }

    console.log(`${account.name}: ${data.msg}`);

    const rawCookieArray = response.headers.getSetCookie?.() || [];

    if (!rawCookieArray.length) {
      throw new Error("Cookie 获取失败");
    }

    return {
      ...account,
      cookie: formatCookie(rawCookieArray),
    };
  } catch (err) {
    throw new Error(`登录异常: ${err.message}`);
  }
}

// 签到
async function checkIn(account) {
  try {
    const response = await fetch(checkInUrl, {
      method: "POST",
      headers: {
        Cookie: account.cookie,
      },
    });

    if (!response.ok) {
      throw new Error(`签到请求失败 ${response.status}`);
    }

    const data = await response.json();

    if (!data.msg) {
      throw new Error("签到返回异常");
    }

    console.log(`${account.name}: ${data.msg}`);

    return data.msg;
  } catch (err) {
    throw new Error(`签到异常: ${err.message}`);
  }
}

// 推送结果到 API
async function pushResult(message) {
  try {
    const encoded = encodeURIComponent(message);

    const url = API_BASE + encoded;

    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`API 推送失败 ${res.status}`);
    }

    console.log(`推送成功: ${message}`);
  } catch (err) {
    console.error(`推送失败: ${message} -> ${err.message}`);
  }
}

// 单账号流程
async function processSingleAccount(account) {
  try {
    const cookedAccount = await logIn(account);

    const result = await checkIn(cookedAccount);

    await pushResult(`${account.name}: ${result}`);

    return result;
  } catch (err) {
    const errorMsg = `${account.name}: ${err.message}`;

    console.error(errorMsg);

    await pushResult(errorMsg);

    throw new Error(err.message);
  }
}

// GitHub 输出
function setGitHubOutput(name, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<EOF\n${value}\nEOF\n`);
}

// 主程序
async function main() {
  let accounts;

  try {
    if (!process.env.ACCOUNTS) {
      throw new Error("未配置 ACCOUNTS");
    }

    accounts = JSON.parse(process.env.ACCOUNTS);

    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error("账户列表为空");
    }
  } catch (err) {
    const message = `❌ 账户配置错误: ${err.message}`;

    console.error(message);

    setGitHubOutput("result", message);

    process.exit(1);
  }

  console.log(`开始签到，共 ${accounts.length} 个账号\n`);

  const results = await Promise.allSettled(
    accounts.map((account) => processSingleAccount(account))
  );

  console.log("\n======== 签到结果 ========\n");

  const lines = [];

  results.forEach((result, index) => {
    const name = accounts[index].name;

    const success = result.status === "fulfilled";

    const icon = success ? "✅" : "❌";

    const message = success ? result.value : result.reason.message;

    const line = `${name}: ${icon} ${message}`;

    lines.push(line);

    success ? console.log(line) : console.error(line);
  });

  const finalMsg = lines.join("\n");

  setGitHubOutput("result", finalMsg);
}

main();
