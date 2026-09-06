<script setup lang="ts">
import { ref } from 'vue';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import {
  getServerBase,
  hasServerBase,
  serverSetupOpen,
  setServerBase,
} from '@/web/serverConfig';

serverSetupOpen.value = serverSetupOpen.value || !hasServerBase();
const open = serverSetupOpen;
const value = ref(getServerBase());
const testing = ref(false);
const testMessage = ref('');
const testOk = ref(false);

const normalizeInput = () => value.value.trim().replace(/\/+$/, '');

const runTest = async (): Promise<boolean> => {
  const base = normalizeInput();
  testing.value = true;
  testMessage.value = '';
  testOk.value = false;
  try {
    const response = await fetch(`${base}/search/hot`, { credentials: 'include' });
    testOk.value = response.status < 500;
    testMessage.value = testOk.value ? '连接成功' : `服务返回异常状态码 ${response.status}`;
    return testOk.value;
  } catch {
    testMessage.value = '连接失败：请检查地址是否正确、服务器已启动、且启用了 CORS';
    return false;
  } finally {
    testing.value = false;
  }
};

const isValidInput = () => {
  try {
    const url = new URL(normalizeInput());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const handleSave = () => {
  if (!isValidInput()) {
    testMessage.value = '地址格式无效，请输入 http(s):// 开头的完整地址';
    return;
  }
  setServerBase(normalizeInput());
  open.value = false;
  window.location.reload();
};
</script>

<template>
  <Dialog
    v-model:open="open"
    title="配置服务端地址"
    contentClass="server-setup-dialog"
    :contentStyle="{ width: '520px', maxWidth: '92vw' }"
    :showClose="false"
    :closeOnEscape="false"
    :closeOnInteractOutside="false"
  >
    <div class="server-setup">
      <p class="server-setup-tip">
        这是浏览器版本的 EchoMusic。API 服务需要独立部署（仓库 server/ 目录），
        请在下方填写其地址，该地址只会保存在本机浏览器中。
      </p>
      <div class="server-setup-warning">
        <strong>安全提示：</strong>
        强烈建议使用<b>自己部署</b>的 API 服务。若连接他人提供的公共服务，
        对方可完整读取你的账号凭证、歌单、搜索与播放记录等一切经由该服务的数据，
        存在账号被盗与隐私泄露风险，请自行评估后再使用。
      </div>
      <div class="server-setup-field">
        <Input
          v-model="value"
          class="server-setup-input"
          placeholder="https://api.example.com"
          spellcheck="false"
          autocomplete="off"
          @keyup.enter="handleSave"
        />
      </div>
      <div v-if="testMessage" class="server-setup-test" :class="{ 'is-ok': testOk }">
        {{ testMessage }}
      </div>
    </div>

    <template #footer>
      <Button
        class="server-setup-button"
        variant="ghost"
        size="sm"
        :loading="testing"
        @click="runTest"
      >
        测试连接
      </Button>
      <Button
        class="server-setup-button server-setup-button--primary"
        variant="primary"
        size="sm"
        :loading="testing"
        @click="handleSave"
      >
        保存并重试
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
@reference "@/style.css";

.server-setup {
  @apply space-y-3;
}

.server-setup-tip {
  @apply text-sm leading-6 text-text-secondary;
}

.server-setup-warning {
  @apply text-sm leading-6 rounded-xl border border-solid p-3;
  color: var(--state-danger);
  border-color: color-mix(in srgb, var(--state-danger) 40%, transparent);
  background: color-mix(in srgb, var(--state-danger) 8%, transparent);
}

.server-setup-field {
  @apply flex items-center gap-2;
}

.server-setup-input {
  @apply flex-1;
}

.server-setup-test {
  @apply text-sm;
  color: var(--state-danger);
}

.server-setup-test.is-ok {
  color: var(--state-ok, #22c55e);
}

.server-setup-button {
  @apply min-w-[96px] rounded-lg text-[13px] font-semibold;
}
</style>