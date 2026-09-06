# -*- coding: utf-8 -*-
"""照片存储抽象层（StorageAdapter）。

为什么需要它
------------
当前照片存在本地 instance/uploads/，前端硬编码拼 `/uploads/<filename>`。
未来若要迁到腾讯云 COS / 阿里云 OSS（起因：CloudStudio 免费版只有 4GB 磁盘），
照片就不在本地了 —— 到那时 DB 里存的仍是同一个 key，但访问地址要变成
`https://bucket.cos.ap-shanghai.myqcloud.com/xxx.jpg`。

有了这一层，迁移成本被压到最小：
- 迁移时只改本文件（加个 CosStorage 类 + 切一下实例）
- app.py / app.js 完全不用动（前端只读后端返回的 `url` 字段）

契约
----
- `key`：数据库里存的东西（LocalDisk 下就是 filename，如 `a1b2c3.jpg`）
- `url_for(key)`：浏览器可直接访问的地址
  - LocalDisk → `/uploads/a1b2c3.jpg`（相对路径，同域）
  - Cos       → `https://bucket.cos.../a1b2c3.jpg`（绝对 URL，跨域 CDN）

前端**永远不要自己拼 URL**，一律用后端给的 `url` 字段 —— 这是迁移零改动的关键。
"""
import os


class StorageAdapter:
    """存储适配器基类。子类需实现 save / url_for / delete / list_keys。"""

    def save(self, file_storage, key):
        """保存一个 Flask FileStorage 对象，返回 key。"""
        raise NotImplementedError

    def url_for(self, key):
        """返回浏览器可直接访问的 URL（相对路径或绝对 URL 均可）。"""
        raise NotImplementedError

    def delete(self, key):
        """删除一个 key，返回是否成功。不存在也算成功（幂等）。"""
        raise NotImplementedError

    def abspath(self, key):
        """本地绝对路径；云存储返回 None（调用方需自行处理）。"""
        return None

    def list_keys(self):
        """列出所有 key（备份打包用）。"""
        raise NotImplementedError

    def ensure(self):
        """确保存储可用（建目录 / 建 bucket），启动时调用一次。"""
        pass


class LocalDiskStorage(StorageAdapter):
    """本地磁盘存储 —— 当前默认实现，行为等价于原来的 /uploads/。"""

    def __init__(self, base_dir, url_prefix='/uploads/'):
        self.base_dir = base_dir
        self.url_prefix = url_prefix

    def ensure(self):
        os.makedirs(self.base_dir, exist_ok=True)

    def save(self, file_storage, key):
        self.ensure()
        file_storage.save(os.path.join(self.base_dir, key))
        return key

    def url_for(self, key):
        return f'{self.url_prefix}{key}'

    def delete(self, key):
        path = self.abspath(key)
        if path and os.path.exists(path):
            try:
                os.remove(path)
                return True
            except OSError:
                return False
        return True

    def abspath(self, key):
        return os.path.join(self.base_dir, key)

    def list_keys(self):
        if not os.path.isdir(self.base_dir):
            return []
        return [f for f in os.listdir(self.base_dir)
                if os.path.isfile(os.path.join(self.base_dir, f))]


# 未来迁云存储时，在这里加 CosStorage / OssStorage，然后把 build_storage()
# 的返回换掉即可。app.py 与前端都不需要改。
def build_storage(upload_dir):
    """构造当前使用的存储适配器。

    切换云存储的方式（未来）：
        return CosStorage(secret_id=..., secret_key=..., bucket=..., region=...)
    """
    return LocalDiskStorage(upload_dir)
