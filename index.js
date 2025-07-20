// >_  node index.js || npm run dev
const fs = require('fs');
const Path = require('path');
const https = require('https');
const { parseStringPromise } = require('xml2js');

// Files
const DUMP_DIR = Path.join(__dirname, '.dump.xx');
const CREDS_FILE = Path.join(__dirname, 'creds.json');
const SESSION_FILE = Path.join(DUMP_DIR, 'session.json');
const METADATA_FILE = Path.join(DUMP_DIR, 'metadata.json');
const RECORDS_FILE = Path.join(DUMP_DIR, 'records.json');

// Cache
const Cache = {
    creds: undefined,
    apiVersion: undefined,
    session: undefined,
};

// Generate UUID
function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// sleep milliseconds promise
function sleep(ms) {
    return new Promise((resolve) => void setTimeout(() => resolve(ms), ms));
}

// Path info
function pathInfo(path, mode = 0) {
	const _get_type = (info) => {
		if (info.isFile) return info.isSymbolicLink ? 4 : 1; 
		if (info.isDirectory) return info.isSymbolicLink ? 3 : 2; 
		return 0;
	}
	const _get_stats = (stats) => ({
		type: 0,
		path,
		path_full: Path.resolve(path),
		dir: Path.dirname(path),
		dir_full: Path.dirname(path, true),
		basename: Path.basename(path),
		target: fs.realpathSync(path),
		dev: stats.dev,
		mode: stats.mode,
		nlink: stats.nlink,
		uid: stats.uid,
		gid: stats.gid,
		rdev: stats.rdev,
		blksize: stats.blksize,
		ino: stats.ino,
		size: stats.size,
		blocks: stats.blocks,
		atimeMs: stats.atimeMs,
		mtimeMs: stats.mtimeMs,
		ctimeMs: stats.ctimeMs,
		birthtimeMs: stats.birthtimeMs,
		atime: stats.atime,
		mtime: stats.mtime,
		ctime: stats.ctime,
		birthtime: stats.birthtime,
		isDirectory: stats.isDirectory(),
		isFile: stats.isFile(),
		isBlockDevice: stats.isBlockDevice(),
		isCharacterDevice: stats.isCharacterDevice(),
		isSymbolicLink: stats.isSymbolicLink(),
		isFIFO: stats.isFIFO(),
		isSocket: stats.isSocket(),
	});
	let info = undefined;
	if (fs.existsSync(path)) {
		mode = [0, 1, 2].includes(mode = parseInt(mode) ?? 0) ? mode : 0
		if (mode === 0) info = _get_stats(fs.statSync(path));
		else if (mode === 1) info = _get_stats(fs.lstatSync(path));
		else {
			const stats = _get_stats(fs.statSync(path));
			const lstats = _get_stats(fs.lstatSync(path));
			for (const key in lstats){
				if (!lstats.hasOwnProperty(key)) continue;
				stats[key] = stats[key] || lstats[key];
			}
			info = stats;
		}
	}
	if (info) info.type = _get_type(info);
	return info;
};

// Validate directory path
function isDir(path, follow_symlink = true) {
	const info = pathInfo(path, follow_symlink ? 0 : 1);
	return !info ? false : info.isDirectory;
};

// Validate file path
function isFile(path, follow_symlink = true) {
	const info = pathInfo(path, follow_symlink ? 0 : 1);
	return !info ? false : !info.isDirectory;
}

// Create directory
function mkdir(path, mode = 0o777, recursive = true) {
    let info = pathInfo(path);
	if (info) {
		if (!info.isDirectory) throw new Error(`Create directory failed! The path already exists "${info.path_full}" (type = ${info.type}).`);
		return info.path_full;
	}
	try {
		fs.mkdirSync(path, {mode, recursive});
		if (!((info = pathInfo(path)) && info.isDirectory)) throw new TypeError(`Failed to resolve created directory real path (${path}).`);
		return info.path_full;
	}
	catch (e){
		throw new Error(`Create directory failed! ${e}`);
	}
}

// Read file
function readSync(path, parse = false, _default = undefined, _encoding = undefined) {
	try {
		if (!isFile(path)) throw new Error(`Read file does not exist (${path}).`);
		const buffer = fs.readFileSync(path, _encoding);
		if (!parse) return buffer;
		const content = buffer.toString();
		if (parse !== 'json') return content;
        let json, fail = `__fail_${Date.now()}__`;
        try {
            if (Object(json = JSON.parse(content)) !== json) json = fail;
        } catch (e) {
            json = fail;
        }
		if (json === fail) throw new Error(`Read file JSON parse content failed. (${path})`);
		return json;
	}
	catch (e) {
		if (_default === undefined) console.warn('[-] readSync failure: ', e);
		return _default;
	}
}

// Write file
function writeSync(path, content, append = false, abortController = undefined) {
	const opts = {};
	if (abortController instanceof AbortController) {
		const { signal } = abortController;
		opts.signal = signal;
	}
	if (append) opts.flag = 'a+';
    let dir = Path.dirname(path);
    if (dir !== '.' && !isDir(dir)) {
        dir = mkdir(dir);
        console.debug('[*] writeSync > mkdir:', {dir, path});
    }
	return fs.writeFileSync(path, content, opts);
}

// SOAP request helper
function soapRequest(url, headers, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method: 'POST',
            headers
        }, res => {
            let data = ''
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// Login and get session ID
async function login() {
    const { username, password, token, loginUrl } = Cache.creds;
    const body = `
        <env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema"
                      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                      xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
            <env:Body>
                <n1:login xmlns:n1="urn:partner.soap.sforce.com">
                    <n1:username>${username}</n1:username>
                    <n1:password>${password}${token || ''}</n1:password>
                </n1:login>
            </env:Body>
        </env:Envelope>
    `;
    const headers = {
        'Content-Type': 'text/xml',
        'SOAPAction': 'login',
        'Content-Length': Buffer.byteLength(body),
    };

    // session login
    console.debug('[*] Session Login...', [loginUrl, username]);
    const response = await soapRequest(loginUrl, headers, body);
    const result = await parseStringPromise(response);
    const res = result['soapenv:Envelope']['soapenv:Body'][0]['loginResponse'][0]['result'][0];
    
    // save session
    writeSync(SESSION_FILE, JSON.stringify(res, undefined, 4));
    console.log('[+] Session Saved:', SESSION_FILE.substring(__dirname.length + 1));
    
    // result
    return {
        sessionId: res.sessionId[0],
        serverUrl: res.serverUrl[0],
        metadataUrl: res.metadataServerUrl[0],
    };
}

// Describe Metadata
async function describeMetadata() {
    const { sessionId, metadataUrl } = Cache.session, apiVersion = Cache.apiVersion;
    const body = `
        <env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema"
                      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                      xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
            <env:Header>
                <n1:SessionHeader xmlns:n1="http://soap.sforce.com/2006/04/metadata">
                    <n1:sessionId>${sessionId}</n1:sessionId>
                </n1:SessionHeader>
            </env:Header>
            <env:Body>
                <n2:describeMetadata xmlns:n2="http://soap.sforce.com/2006/04/metadata">
                    <n2:asOfVersion>${apiVersion}</n2:asOfVersion>
                </n2:describeMetadata>
            </env:Body>
        </env:Envelope>
    `;
    const headers = {
        'Content-Type': 'text/xml',
        'SOAPAction': 'describeMetadata',
        'Content-Length': Buffer.byteLength(body),
    };
    
    // describe metadata
    console.debug('[*] Describe Metadata...', { sessionId, metadataUrl, apiVersion });
    const response = await soapRequest(metadataUrl, headers, body);
    const result = await parseStringPromise(response);
    const metadata = result['soapenv:Envelope']['soapenv:Body'][0]['describeMetadataResponse'][0]['result'][0];
    
    // metadata save output
    writeSync(METADATA_FILE, JSON.stringify(metadata, null, 4));
    console.log('[+] Metadata Saved:', METADATA_FILE.substring(__dirname.length + 1));
    
    // result
    return metadata;
}

// list metadata
async function listMetadata(type, folder = undefined, tag = undefined) {
    const { sessionId, metadataUrl } = Cache.session, apiVersion = Cache.apiVersion;
    const body = `
        <env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema"
                      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                      xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
            <env:Header>
                <n1:SessionHeader xmlns:n1="http://soap.sforce.com/2006/04/metadata">
                    <n1:sessionId>${sessionId}</n1:sessionId>
                </n1:SessionHeader>
            </env:Header>
            <env:Body>
                <n2:listMetadata xmlns:n2="http://soap.sforce.com/2006/04/metadata">
                    <n2:queries>
                        <n2:type>${type}</n2:type>
                        ${folder ? `<n2:folder>${folder}</n2:folder>` : ''}
                    </n2:queries>
                    <n2:asOfVersion>${apiVersion}</n2:asOfVersion>
                </n2:listMetadata>
            </env:Body>
        </env:Envelope>
    `;
    const headers = {
        'Content-Type': 'text/xml',
        'SOAPAction': 'listMetadata',
        'Content-Length': Buffer.byteLength(body),
    };

    // list type metadata
    console.debug(`[*]${tag ? ` ${tag}` : ''} List ${type}${folder ? ` (folder: ${folder})` : ''} Metadata...`);
    const xml = await soapRequest(metadataUrl, headers, body);
    const res = await parseStringPromise(xml);
    const items = res?.['soapenv:Envelope']?.['soapenv:Body']?.[0]?.['listMetadataResponse']?.[0]?.['result'] || [];
    const results = [];
    for (const item of items) {
        results.push({
            id: item.id[0] || null,
            type: item.type[0] || null,
            fullName: item.fullName[0] || null,
            fileName: item.fileName[0] || null,
            createdById: item.createdById[0] || null,
            createdByName: item.createdByName[0] || null,
            createdDate: item.createdDate[0] || null,
            lastModifiedById: item.lastModifiedById[0] || null,
            lastModifiedByName: item.lastModifiedByName[0] || null,
            lastModifiedDate: item.lastModifiedDate[0] || null,
            namespacePrefix: item.hasOwnProperty('namespacePrefix') ? item.namespacePrefix[0] : null,
            manageableState: item.hasOwnProperty('manageableState') ? item.manageableState[0] : null,
        });
    }
    console.debug(`[*]${tag ? ` ${tag}` : ''} List ${type}${folder ? ` (folder: ${folder})` : ''} Metadata Results: ${results.length}`);
    
    // results
    return results;
}

// SOQL Query
async function query(soql, tooling = false) {
    const { sessionId, serverUrl } = Cache.session;
    const body = tooling
    ? `
        <env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"
                      xmlns:xsd="http://www.w3.org/2001/XMLSchema"
                      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
            <env:Header>
                <n1:SessionHeader xmlns:n1="urn:tooling.soap.sforce.com">
                    <n1:sessionId>${sessionId}</n1:sessionId>
                </n1:SessionHeader>
            </env:Header>
            <env:Body>
                <n2:query xmlns:n2="urn:tooling.soap.sforce.com">
                    <n2:queryString>${soql}</n2:queryString>
                </n2:query>
            </env:Body>
        </env:Envelope>
    `
    : `
        <env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"
              xmlns:xsd="http://www.w3.org/2001/XMLSchema"
              xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
            <env:Header>
                <n1:SessionHeader xmlns:n1="urn:partner.soap.sforce.com">
                <n1:sessionId>${sessionId}</n1:sessionId>
                </n1:SessionHeader>
            </env:Header>
            <env:Body>
                <n2:query xmlns:n2="urn:partner.soap.sforce.com">
                <n2:queryString>${soql}</n2:queryString>
                </n2:query>
            </env:Body>
        </env:Envelope>
    `;
    const headers = {
        'Content-Type': 'text/xml',
        'SOAPAction': 'query',
        'Content-Length': Buffer.byteLength(body)
    };

    // query soql
    const url = tooling ? serverUrl.match(/(.*\/Soap\/u\/[^\/]+)/)[0].replace(/Soap\/u/, 'Soap/T') : serverUrl;
    console.debug('[*] Query SOQL...', { sessionId, url, soql });
    const response = await soapRequest(url, headers, body);
    const parsed = await parseStringPromise(response);
    const items = parsed['soapenv:Envelope']['soapenv:Body'][0]['queryResponse'][0]['result'][0]['records'];
    const records = [];
    for (const item of items) {
        const record = {};
        for (const key in item) {
            if (!item.hasOwnProperty(key)) continue;
            if (key === '$') continue;
            if (key === 'sf:type') continue;
            const k = key.replace(/^sf:/, '');
            if (k === 'Id' && 'object' === typeof item[key][0]) continue;
            record[k] = item[key][0];
        }
        records.push(record);
    }

    // result
    return records;
}

// Main
(async () => {
    try {
        // login
        const creds = readSync(CREDS_FILE, 'json', undefined, 'utf8');
        if (Object(creds) !== creds) throw new Error('Failed to load creds!');
        Cache.creds = creds;
        Cache.apiVersion = creds.loginUrl.split('/').pop();
        Cache.session = await login();

        // FIXME: test query
        /*
        const soql = 'SELECT MetadataComponentId, MetadataComponentNamespace, MetadataComponentName, MetadataComponentType, RefMetadataComponentId, RefMetadataComponentNamespace, RefMetadataComponentName, RefMetadataComponentType FROM MetadataComponentDependency';
        const res = await query(soql, true);
        console.log('[+] query result: ', JSON.stringify(res, undefined, 4));
        return;
        */

        // describe metadata (all)
        const metadata = await describeMetadata();

        // records - parse metadata
        const records = {
            package: {
                id: 1,
                random_id: uuid(),
                created_date: new Date().toISOString(),
                finished_date: null,
                username: creds.username,
                api_version: Cache.apiVersion,
                access_token: Cache.session.sessionId,
                instance_url: Cache.session.metadataUrl.match(/https:\/\/[^\/]+?(?=\/)/)[0],
                component_option: 'all', // all|wildcard_only|none|unmanaged (component.manageableState == 'unmanaged')
                package: null,
                status: null, // Not Started|Running|Finished|Error
                error: null,
            },
            componentTypes: {
                '__example_component_type': {
                    package: 1,
                    parent: null,
                    name: '__example_component_type',
                    suffix: null,
                    directory_name: null,
                    in_folder: false,
                    meta_file: false,
                    children: null,
                },
            },
            components: {
                '__example_component': {
                    key: null,
                    component_type: '__example_component_type',
                    name: '__example_component',
                    id: null,
                    type: null,
                    file_name: null,
                    created_by_id: null,
                    created_by_name: null,
                    created_date: null,
                    last_modified_by_id: null,
                    last_modified_by_name: null,
                    last_modified_date: null,
                    namespace_prefix: null,
                    manageable_state: null,
                },
            },
        };
        const _includeComponent = (component) => {
            const opt = records.package.component_option;
            if (opt === 'all') return true;
            if (opt === 'none') return component.namespacePrefix === null;
            if (opt === 'unmanaged') return [null, 'unmanaged'].includes(component.manageableState);
            return true;
        };
        const isWildcard = records.package.component_option === 'wildcard_only';
        const metadataObjects = (metadata.metadataObjects || []);
        const mLen = metadataObjects.length;
        for (let n = 0; n < mLen; n ++) {
            const obj = metadataObjects[n];
            const objTag = `(${n + 1}/${mLen})`;
            const metaObject = {
                directoryName: obj.directoryName[0],
                inFolder: obj.inFolder[0] === 'true',
                metaFile: obj.metaFile[0] === 'true',
                suffix: obj.suffix?.[0] ?? null,
                xmlName: obj.xmlName[0],
                childXmlNames: obj.childXmlNames ?? [],
            };
            if (metaObject.childXmlNames.length) {
                for (const childXmlName of metaObject.childXmlNames) {
                    records.componentTypes[childXmlName] = {
                        package: records.package.id,
                        parent: metaObject.xmlName,
                        name: childXmlName,
                        suffix: null,
                        directory_name: null,
                        in_folder: false,
                        meta_file: false,
                        children: null,
                    };
                }
            }
            records.componentTypes[metaObject.xmlName] = {
                package: records.package.id,
                parent: null,
                name: metaObject.xmlName,
                suffix: metaObject.suffix,
                directory_name: metaObject.directoryName,
                in_folder: metaObject.inFolder,
                meta_file: metaObject.metaFile,
                children: metaObject.childXmlNames.join(', ') || null,
            };
            let isComponent = false;
            if (!metaObject.inFolder && !isWildcard) {
                if (metaObject.childXmlNames.length) {
                    for (let i = 0; i < metaObject.childXmlNames.length; i ++) {
                        let type = metaObject.childXmlNames[i];
                        if (type === 'ManagedTopic') type = 'ManagedTopics'; // ManagedTopic is not a valid component Type and it should be 'ManagedTopics'
                        const tag = `${(i + 1)}/${metaObject.childXmlNames.length}`;
                        const results = await listMetadata(type, undefined, tag).catch(err => {
                            console.error(`[!] ${tag} list metadata (${metaObject.xmlName} => ${type}) failure:`, err);
                            return [];
                        });
                        for (const res of results) {
                            if (!records.componentTypes.hasOwnProperty(res.type)) {
                                console.log(`[i] The "${res.type}" component type does not exist for "${res.fullName}".`);
                                continue;
                            }
                            if (!_includeComponent(res)) continue;
                            const key = `${res.type}.${res.fullName}`;
                            records.components[key] = {
                                key,
                                component_type: res.type,
                                name: res.fullName,
                                id: res.id,
                                type: res.type,
                                file_name: res.fileName,
                                created_by_id: res.createdById,
                                created_by_name: res.createdByName,
                                created_date: res.createdDate,
                                last_modified_by_id: res.lastModifiedById,
                                last_modified_by_name: res.lastModifiedByName,
                                last_modified_date: res.lastModifiedDate,
                                namespace_prefix: res.namespacePrefix,
                                manageable_state: res.manageableState,
                            };
                        }
                    }
                }
                isComponent = true;
            }
            else if (metaObject.inFolder) {
                let type = metaObject.xmlName;
                if (type === 'EmailTemplate') type = 'EmailFolder'; // EmailTemplate = EmailFolder (for some reason)
                else type = type + 'Folder'; // Append "Folder" keyword onto end of component type
                const folderResults = await listMetadata(type, undefined, objTag).catch(err => {
                    console.error(`[!] ${objTag} list metadata (${metaObject.xmlName} => ${type}) failure:`, err);
                    return [];
                });
                for (let i = 0; i < folderResults.length; i ++) {
                    const tag = `${objTag} folder ${i + 1}/${folderResults.length}`;
                    const folderRes = folderResults[i];
                    if (_includeComponent(folderRes)) {
                        const key = `${metaObject.xmlName}.${folderRes.fullName}`;
                        records.components[key] = {
                            key,
                            component_type: metaObject.xmlName,
                            name: folderRes.fullName,
                            id: folderRes.id,
                            type: folderRes.type,
                            file_name: folderRes.fileName,
                            created_by_id: folderRes.createdById,
                            created_by_name: folderRes.createdByName,
                            created_date: folderRes.createdDate,
                            last_modified_by_id: folderRes.lastModifiedById,
                            last_modified_by_name: folderRes.lastModifiedByName,
                            last_modified_date: folderRes.lastModifiedDate,
                            namespace_prefix: folderRes.namespacePrefix,
                            manageable_state: folderRes.manageableState,
                        };
                    }
                    const results = await listMetadata(metaObject.xmlName, folderRes.fullName, tag).catch(err => {
                        console.error(`[!] ${tag} list metadata (${metaObject.xmlName} => ${type} => ${folderRes.fullName}) failure:`, err);
                        return [];
                    });
                    for (const res of results) {
                        if (!_includeComponent(res)) continue;
                        const key = `${metaObject.xmlName}.${folderRes.fullName}.${res.fullName}`;
                        records.components[key] = {
                            key,
                            component_type: metaObject.xmlName,
                            name: res.fullName,
                            id: res.id,
                            type: res.type,
                            file_name: res.fileName,
                            created_by_id: res.createdById,
                            created_by_name: res.createdByName,
                            created_date: res.createdDate,
                            last_modified_by_id: res.lastModifiedById,
                            last_modified_by_name: res.lastModifiedByName,
                            last_modified_date: res.lastModifiedDate,
                            namespace_prefix: res.namespacePrefix,
                            manageable_state: res.manageableState,
                        };
                    }
                }
            }
            if (isComponent) {
                const tag = `${objTag} Component`;
                const results = await listMetadata(metaObject.xmlName, undefined, tag).catch(err => {
                    console.error(`[!] ${tag} list metadata (${metaObject.xmlName}) failure:`, err);
                    return [];
                });
                for (const res of results) {
                    if (!records.componentTypes.hasOwnProperty(res.type)) {
                        console.log(`[i] The "${res.type}" component type does not exist for "${res.fullName}".`);
                        continue;
                    }
                    if (!_includeComponent(res)) continue;
                    const key = `${res.type}.${res.fullName}`;
                    records.components[key] = {
                        key,
                        component_type: res.type,
                        name: res.fullName,
                        id: res.id,
                        type: res.type,
                        file_name: res.fileName,
                        created_by_id: res.createdById,
                        created_by_name: res.createdByName,
                        created_date: res.createdDate,
                        last_modified_by_id: res.lastModifiedById,
                        last_modified_by_name: res.lastModifiedByName,
                        last_modified_date: res.lastModifiedDate,
                        namespace_prefix: res.namespacePrefix,
                        manageable_state: res.manageableState,
                    };
                }
            }
        }

        // records - save output
        writeSync(RECORDS_FILE, JSON.stringify(records, undefined, 4));
        console.log('[+] Records Saved:', RECORDS_FILE.substring(__dirname.length + 1));

        // done
        console.log('[+] done.');
    } catch (err) {

        // failure
        console.error('[!] Failed:', err.message || err);
        process.exit(1);
    }
})();
