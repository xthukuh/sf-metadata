// >_  node index.js || npm run dev
const fs = require('fs');
const Path = require('path');
const https = require('https');
const { parseStringPromise } = require('xml2js');
const { _uuid, Term, _jsonStringify } = require('xtutils');

// Files
const DUMP_DIR = Path.join(__dirname, '.dump.xx');
const CREDS_FILE = Path.join(__dirname, 'creds.json');
const SESSION_FILE = Path.join(DUMP_DIR, 'session.json');
const METADATA_FILE = Path.join(DUMP_DIR, 'metadata.json');
const RECORDS_FILE = Path.join(DUMP_DIR, 'records.json');
const DEPENDENCIES_FILE = Path.join(DUMP_DIR, 'dependencies.json');
const DEPLOYMENTS_FILE = Path.join(DUMP_DIR, 'deployments.json');

// Cache
const Cache = {
    creds: undefined,
    apiVersion: undefined,
    session: undefined,
};

// print
let print_last_len = 0;
function printLn(text, offset = 0) {
    let len = (text = String(text)).length, pos = 0;
    if ((offset = parseInt(offset) ?? 0) !== 0) {
        process.stdout.moveCursor(0, -1);
        process.stdout.cursorTo(pos = (pos = print_last_len - 1 + offset) < 0 ? 0 : pos);
        len += pos;
    }
    process.stdout.write(text + '\n');
    print_last_len = len + 1;
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

    // authentication
    printLn(`[*] Session login...`);
    const response = await soapRequest(loginUrl, headers, body);
    const result = await parseStringPromise(response);
    const res = result['soapenv:Envelope']['soapenv:Body'][0]['loginResponse'][0]['result'][0];
    printLn(`: Authenticated!`, -3);
    writeSync(SESSION_FILE, JSON.stringify(res, undefined, 4));
    printLn(` └─ ${SESSION_FILE.substring(__dirname.length + 1)}`);
    
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
    printLn('[*] Describe all metadata...');
    const response = await soapRequest(metadataUrl, headers, body);
    const result = await parseStringPromise(response);
    const metadata = result['soapenv:Envelope']['soapenv:Body'][0]['describeMetadataResponse'][0]['result'][0];
    printLn(`: Found ${metadata.metadataObjects.length} metadata objects.`, -3);
    writeSync(METADATA_FILE, JSON.stringify(metadata, null, 4));
    printLn(` └─ ${METADATA_FILE.substring(__dirname.length + 1)}`);
    
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

    // list metadata
    const listTag = `${tag ? ` ${tag}` : ''}`;
    const listType = `${type}${folder ? ` - ${folder}` : ''}`;
    printLn(`[*]${listTag} ${listType} List metadata...`);
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
    printLn(`: Found ${results.length} components.`, -3);
    
    // results
    return results;
}

// SOQL Query
async function query(soql, tooling = false, tag = undefined, file = undefined) {
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
    printLn(`[*] Query${tag ? ' ' + tag : ''}...`);
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
    printLn(`: Found ${records.length} records.`, -3);
    if (file) {
        writeSync(file, JSON.stringify(records, undefined, 4));
        printLn(` └─ ${file.substring(__dirname.length + 1)}`);
    }

    // results
    return records;
}

// deployment stages
function deploymentStages2(dependencies) {
    const graph = new Map();
    const inDegree = new Map();
    const componentMap = new Map();

    for (const dep of dependencies) {
        const parentId = dep.RefMetadataComponentId;
        const childId = dep.MetadataComponentId;
        componentMap.set(parentId, {
            id: parentId,
            name: dep.RefMetadataComponentName,
            type: dep.RefMetadataComponentType
        })
        componentMap.set(childId, {
            id: childId,
            name: dep.MetadataComponentName,
            type: dep.MetadataComponentType
        })
        if (!graph.has(parentId)) graph.set(parentId, new Set());
        graph.get(parentId).add(childId);
        inDegree.set(childId, (inDegree.get(childId) || 0) + 1);
        if (!inDegree.has(parentId)) inDegree.set(parentId, 0);
    }
    const queue = [...inDegree.entries()].filter(([_, deg]) => deg === 0).map(([id]) => id)
    const visited = new Set();
    const result = [];
    let stageIndex = 1;
    while (queue.length > 0) {
        const nextQueue = [];
        const stageComponents = [];
        for (const id of queue) {
            if (visited.has(id)) continue;
            visited.add(id);
            const comp = componentMap.get(id);
            stageComponents.push(`${stageIndex} [${comp.type}] ${comp.name} (${comp.id})`);
            if (graph.has(id)) {
                for (const childId of graph.get(id)) {
                    inDegree.set(childId, inDegree.get(childId) - 1);
                    if (inDegree.get(childId) === 0) {
                        nextQueue.push(childId);
                    }
                }
            }
        }
        if (stageComponents.length > 0) {
            result.push(...stageComponents);
            stageIndex++
        }
        queue.length = 0;
        queue.push(...nextQueue);
    }
    // stageIndex ++;
    const stageComponents = [];
    const rest = [...inDegree.entries()].filter(([_,v]) => v > 0);
    console.debug('[*] rest:', rest);
    rest.forEach(([k]) => {
        inDegree.set(k, 0);
        const comp = componentMap.get(k);
        stageComponents.push(`${stageIndex} [${comp.type}] ${comp.name} (${comp.id})`);
    });
    result.push(...stageComponents);
    console.debug('inDegree > 0:', rest.filter(v => !visited.has(v[0])));
    // console.debug('[*] graph:', graph);
    return result
}

// deployment stages
function deploymentStages(dependencies) {
    const components = {};
    for (const dep of dependencies) {
        const childId = dep.MetadataComponentId;
        const parentId = dep.RefMetadataComponentId;
        const child = components.hasOwnProperty(childId) ? components[childId] : components[childId] = {
            id: dep.MetadataComponentId,
            name: dep.MetadataComponentName,
            type: dep.MetadataComponentType,
            parents: {},
            children: {},
            related: {},
            count: 0,
        };
        const parent = components.hasOwnProperty(parentId) ? components[parentId] : components[parentId] = {
            id: dep.RefMetadataComponentId,
            name: dep.RefMetadataComponentName,
            type: dep.RefMetadataComponentType,
            parents: {},
            children: {},
            related: {},
            count: 0,
        };
        if (!parent.children.hasOwnProperty(childId)) parent.children[childId] = `${child.type} - ${child.name}`;
        if (!child.parents.hasOwnProperty(parentId)) child.parents[parentId] = `${parent.type} - ${parent.name}`;
        components[childId].count ++;
        // for (const [key, val] of Object.entries(child.parents)) {
        //     if (!components.hasOwnProperty(key)) continue;
        //     const parent = components[key];
        //     for (const [k, v] of Object.entries(parent.children)) {
        //         if (k === childId) continue;
        //         if (!child.related.hasOwnProperty(k) && components.hasOwnProperty(k)) {
        //             const comp = components[k];
        //             child.related[k] = `${v} (${val})`;
        //             if (!comp.related.hasOwnProperty(childId)) {
        //                 comp.related[k] = `${child.type} - ${child.name} (${val})`;
        //             }
        //         }
        //     }
        // }
    }
    const _load_related = (id) => {
        const child = components[id];
        const _add_parent = (parentId, ref=undefined) => {
            const parent = components[parentId];
            const parentVal = `${parent.type} - ${parent.name}`;
            // if (!child.parents.hasOwnProperty(parentId)) {
            //     child.related[parentId] = `${parentVal}${ref ? ` (${ref})` : ''} [p]`;
            // }
            for (const [key, val] of Object.entries(parent.children)) {
                if (key === id || child.related.hasOwnProperty(key)) continue;
                child.related[key] = `${val} (${ref ? ` (${ref})` : ''} - ${parentVal})`;
                // for (const [k, v] of Object.entries(components[key].parents)) {
                //     _add_parent(k, val);
                // }
            }
        };
        for (const [key] of Object.entries(child.parents)) {
            _add_parent(key);
        }
    };
    for (const [key, comp] of Object.entries(components)) {
        _load_related(key);
    }
    const counts = Object.values(components).reduce((sum, v) => sum + v.count, 0);
    console.debug('[+] counts:', counts, dependencies.length);
    writeSync(DEPLOYMENTS_FILE, JSON.stringify(components, null, 4));
    printLn(` └─ ${DEPLOYMENTS_FILE.substring(__dirname.length + 1)}`);
}

// Main
(async () => {
    try {
        
        // command actions
        const args = process.argv.slice(2);
        const action = args[0];
        if (action === 'deps') {
            console.debug('[*] parse dependencies...');
            const records = readSync(DEPENDENCIES_FILE, 'json', undefined, 'utf8');
            const lines = deploymentStages(records);
            // console.debug('\n[~] stages:\n' + lines.map((v, i) =>`#${i + 1} ${v}`).join('\n'));
            // console.debug('[+] done.');
            return;
        }

        // package metadata
        const t1 = new Date();
        const creds = readSync(CREDS_FILE, 'json', undefined, 'utf8');
        if (Object(creds) !== creds) throw new Error('Failed to load creds!');
        printLn('[i] Package Metadata');
        printLn(` ├─ Login URL: ${creds.loginUrl}`);
        printLn(` └─ Username : ${creds.username}`);
        Cache.creds = creds;
        Cache.apiVersion = creds.loginUrl.split('/').pop();
        Cache.session = await login();

        // query all dependencies
        const dependencies = await query(
            'SELECT MetadataComponentId, MetadataComponentNamespace, MetadataComponentName, MetadataComponentType, RefMetadataComponentId, RefMetadataComponentNamespace, RefMetadataComponentName, RefMetadataComponentType FROM MetadataComponentDependency',
            true,
            'all dependencies',
            DEPENDENCIES_FILE
        );

        // describe all metadata
        const metadata = await describeMetadata();

        // parse records - start
        const records = {
            package: {
                id: 1,
                random_id: _uuid(),
                created_date: t1.toISOString(),
                finished_date: null,
                duration: 0,
                username: creds.username,
                api_version: Cache.apiVersion,
                access_token: Cache.session.sessionId,
                instance_url: Cache.session.metadataUrl.match(/https:\/\/[^\/]+?(?=\/)/)[0],
                component_option: 'all', // all|wildcard_only|none|unmanaged (component.manageableState == 'unmanaged')
                package: null,
                status: null, // Not Started|Running|Finished|Error
                error: null,
            },
            componentTypes: {},
            components: {},
        };
        const _includeComponent = (component) => {
            const opt = records.package.component_option;
            if (opt === 'all') return true;
            if (opt === 'none') return component.namespacePrefix === null;
            if (opt === 'unmanaged') return [null, 'unmanaged'].includes(component.manageableState);
            return true;
        };
        const _addTypeCompKey = (type, key) => {
            const compType = records.componentTypes[type];
            if (Object(compType) !== compType) throw new Error(`[-] unknown add type component ("${type}" => "${key}").`);
            if (!Array.isArray(compType.components)) compType.components = [];
            if (!compType.components.includes(key)) {
                compType.components.push(key);
                compType.components_count ++;
            }
        };
        const isWildcard = records.package.component_option === 'wildcard_only';
        const metadataObjects = (metadata.metadataObjects || []);
        const mLen = metadataObjects.length;
        let compIndex = -1;
        for (let n = 0; n < mLen; n ++) {
            
            // metadata object
            const obj = metadataObjects[n], objTag = `(${n + 1}/${mLen})`;
            const metaObject = {
                directoryName: obj.directoryName[0],
                inFolder: obj.inFolder[0] === 'true',
                metaFile: obj.metaFile[0] === 'true',
                suffix: obj.suffix?.[0] ?? null,
                xmlName: obj.xmlName[0],
                childXmlNames: obj.childXmlNames ?? [],
            };

            // component type
            const cType = metaObject.xmlName;

            // component type children
            if (metaObject.childXmlNames.length) {
                for (const childXmlName of metaObject.childXmlNames) {
                    records.componentTypes[childXmlName] = {
                        package: records.package.id,
                        parent: cType,
                        name: childXmlName,
                        suffix: null,
                        directory_name: null,
                        in_folder: false,
                        meta_file: false,
                        children: null,
                        components: null,
                        components_count: 0,
                    };
                }
            }

            // add component type
            records.componentTypes[cType] = {
                package: records.package.id,
                parent: null,
                name: cType,
                suffix: metaObject.suffix,
                directory_name: metaObject.directoryName,
                in_folder: metaObject.inFolder,
                meta_file: metaObject.metaFile,
                children: metaObject.childXmlNames.join(', ') || null,
                components: null,
                components_count: 0,
            };

            // object metadata components
            let isComponent = false;
            if (!metaObject.inFolder && !isWildcard) {
                if (metaObject.childXmlNames.length) {
                    for (let i = 0; i < metaObject.childXmlNames.length; i ++) {
                        let type = metaObject.childXmlNames[i];
                        if (type === 'ManagedTopic') type = 'ManagedTopics'; // ManagedTopic is not a valid component Type and it should be 'ManagedTopics'
                        const tag = `${objTag} Child ${(i + 1)}/${metaObject.childXmlNames.length}`;
                        const results = await listMetadata(type, undefined, tag)
                        .catch(err => Promise.reject(`[!] ${tag} list metadata (${cType} => ${type}) failure:`, err));
                        for (const res of results) {
                            if (!records.componentTypes.hasOwnProperty(res.type)) {
                                console.log(`[i] The "${res.type}" component type does not exist for "${res.fullName}".`);
                                continue;
                            }
                            if (!_includeComponent(res)) continue;
                            const key = `#${++compIndex}.${n}.c${i}-${res.fullName}` ;
                            records.components[key] = {
                                key,
                                parent: cType,
                                ctype: res.type,
                                name: res.fullName,
                                type: res.type,
                                id: res.id,
                                folder: null,
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
                            _addTypeCompKey(res.type, key);
                        }
                    }
                }
                isComponent = true;
            }
            else if (metaObject.inFolder) {
                let type = cType;
                if (type === 'EmailTemplate') type = 'EmailFolder'; // EmailTemplate = EmailFolder (for some reason)
                else type = type + 'Folder'; // Append "Folder" keyword onto end of component type
                const folderResults = await listMetadata(type, undefined, objTag)
                .catch(err => Promise.reject(`[!] ${objTag} list metadata (${cType} => ${type}) failure:`, err));
                for (let i = 0; i < folderResults.length; i ++) {
                    const tag = `${objTag} Folder ${i + 1}/${folderResults.length}`;
                    const folderRes = folderResults[i];
                    if (_includeComponent(folderRes)) {
                        const key = `#${++compIndex}.${n}.f${i}-${folderRes.fullName}` ;
                        records.components[key] = {
                            key,
                            parent: cType,
                            ctype: cType,
                            name: folderRes.fullName,
                            type: folderRes.type,
                            id: folderRes.id,
                            folder: null,
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
                        _addTypeCompKey(cType, key);
                    }
                    const results = await listMetadata(cType, folderRes.fullName, tag)
                    .catch(err => Promise.reject(`[!] ${tag} list metadata (${cType} => ${type} => ${folderRes.fullName}) failure:`, err));
                    for (let j = 0; j < results.length; j ++) {
                        const res = results[j];
                        if (!_includeComponent(res)) continue;
                        const key = `#${++compIndex}.${n}.f${i}.${j}-${res.fullName}` ;
                        records.components[key] = {
                            key,
                            parent: `${cType}.${folderRes.fullName}`,
                            ctype: cType,
                            name: res.fullName,
                            type: res.type,
                            id: res.id,
                            folder: folderRes.fullName,
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
                        _addTypeCompKey(cType, key);
                    }
                }
            }
            if (isComponent) {
                const tag = `${objTag} Component`;
                const results = await listMetadata(cType, undefined, tag)
                .catch(err => Promise.reject(`[!] ${tag} list metadata (${cType}) failure:`, err));
                for (const res of results) {
                    if (!records.componentTypes.hasOwnProperty(res.type)) {
                        console.log(`[i] The "${res.type}" component type does not exist for "${res.fullName}".`);
                        continue;
                    }
                    if (!_includeComponent(res)) continue;
                    const key = `#${++compIndex}.${n}-${res.fullName}`;
                    records.components[key] = {
                        key,
                        parent: cType,
                        ctype: res.type,
                        type: res.type,
                        name: res.fullName,
                        id: res.id,
                        folder: null,
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
                    _addTypeCompKey(res.type, key);
                }
            }
        }

        // parse records - done
        const t2 = new Date();
        records.package.finished_date = t2.toISOString();
        records.package.duration = `${(t2.getTime() - t1.getTime())/1000} seconds`;
        writeSync(RECORDS_FILE, JSON.stringify(records, undefined, 4));
        printLn('[+] Done.');
        printLn(` └─ ${RECORDS_FILE.substring(__dirname.length + 1)}`);
    }
    catch (err) {
        console.error('[!] FAILURE: ', err);
        process.exit(1);
    }
})();
