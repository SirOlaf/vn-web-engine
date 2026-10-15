# `nekopara_vol1.tpm`

The CxDec storage plugin of NEKOPARA Vol. 1 (internal name `cxdec.tpm.dll`), build SHA-256
`26903726725a45bab530d153e8f06f0607268783c89b3bf3ad300a960259a792`. It provides `TVP_PLUGIN`
(`../tvp-plugin/contract.ts`); `library.ts` registers it. Addresses refer to that build.

| Native                                       | Behaviour                                                                                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `CxPluginLink` (0x10009290)                  | clears `-debugwin`; the module signature check always passes                                                                              |
| `CxFilterFS__Init` (0x10008f10)              | registers medium `archive`, clears storage caches, current directory `archive://data.xp3/`, hooks `Storages.addAutoPath`/`removeAutoPath` |
| `Hook_Storages_addAutoPath` (0x10002940)     | `<app path>name.xp3>rest` → `archive://name.xp3/rest`, other paths unchanged                                                              |
| `XP3IndexParser` (0x1000a470)                | parses the archive index through the core stream; `eliF` names → MD5 entry names                                                          |
| `CxFilterFS__Open` (0x10006a30)              | core stream `<app path>name.xp3><md5 name>`, XOR with the TinyFilterCore key                                                              |
| `CxFilterFS__NormalizePathName` (0x100059c0) | lower case, `/`, leading slashes dropped, runs collapsed, one leading `/`                                                                 |

Archives are indexed when first needed, as natively. Existence checks and listings are
synchronous calls, so the archive must be indexed before them: `V2Link` indexes `data.xp3`, the
auto-path hook indexes the archive it adds (suspending the script meanwhile), and `open` indexes
on demand.
