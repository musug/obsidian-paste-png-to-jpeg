import {
  App, Plugin, PluginSettingTab, Setting, TFile, TAbstractFile,
	MarkdownView, Notice,
} from 'obsidian';

import { renderTemplate } from './template';
import {
   debugLog, path,getVaultConfig, escapeRegExp, ConvertImage,ImageCompressor
} from './utils';

interface PluginSettings {
	// {{imageNameKey}}-{{DATE:YYYYMMDD}}
	imageNamePattern: string
	dupNumberAtStart: boolean
	dupNumberDelimiter: string
	autoRename: boolean
	pngToJpeg: boolean
	quality: string
}

const DEFAULT_SETTINGS: PluginSettings = {
	imageNamePattern: '{{fileName}}',
	dupNumberAtStart: false,
	dupNumberDelimiter: '-',
	autoRename: true,
	pngToJpeg:true,
	quality:'0.6' 
}

const PASTED_IMAGE_PREFIX = 'Pasted image '


export default class PasteImageRenamePlugin extends Plugin {
	settings: PluginSettings

	async onload() 
	{
		const pkg = require('../package.json')
		console.log(`Plugin loading: ${pkg.name} ${pkg.version}`)
		await this.loadSettings();

		this.registerEvent(
			this.app.vault.on('create', (file) => 
			{
				if (!(file instanceof TFile))
					return

				const timeGapMs = (new Date().getTime()) - file.stat.ctime

				// if the pasted image is created more than 1 second ago, ignore it
				if (timeGapMs > 1000)
					return

				if (isPastedImage(file)) 
				{
					debugLog('pasted image created', file)
					this.renameImage(file, this.settings.autoRename)
				} 
			})
		)

		// add settings tab
		this.addSettingTab(new SettingTab(this.app, this));
	}

	async renameImage(file: TFile, autoRename: boolean = false) 
	{
		// get active file first
		const activeFile = this.getActiveFile()
		if (!activeFile) 
		{
			new Notice('Error: No active file found.')
			return
		}

		const { stem, newName, isMeaningful }= this.generateNewName(file, activeFile)
		debugLog('generated newName:', newName, isMeaningful)

		this.renameFile(file, newName, activeFile.path)
	}

	async saveImage(file:File|Blob)
	{
		return new Promise(function(resolve, reject) {

			let reader = new FileReader();
		
			reader.readAsArrayBuffer(file);
		
			reader.onload = function() 
			{
				resolve(this.result);
			}
		});
	}

	async renameFile(file: TFile, newName: string, sourcePath: string) {
		// deduplicate name
		const dirpath = "/image/"
		const isCreate = await this.app.vault.adapter.exists(dirpath);
		if( !isCreate )
		{
			await this.app.vault.createFolder(dirpath);
		}

		newName = await this.deduplicateNewName(newName, dirpath)
		newName = dirpath + "/" + newName;
		debugLog('deduplicated newName:', newName)
		const originName = file.name;

		if( this.settings.pngToJpeg)
		{
			var binary:ArrayBuffer;
			binary = await this.app.vault.readBinary(file);

			let imgBlob:Blob = new Blob( [binary] );
			let img:File;

			const fileType = path.extension(originName);
			const fileName = path.filename(originName);

			//判断文件是不是jpeg 不是jpeg的都转成jpeg 
			if (!['jpeg', 'jpg'].includes(fileType))
			{
				img = await ConvertImage(imgBlob, fileName);  //转jpeg格式的file
			}
			else
			{
				img = new File([imgBlob],originName,{type:imgBlob.type});
			}
	
			newName = dirpath + path.filename(newName) + "."+ path.extension(img.name);
			
			console.log( "newName = " + newName);

			let newImg:File|Blob = await ImageCompressor(img, "file", Number(this.settings.quality) ); //图片压缩
			const formData = new FormData();
			formData.append('file', newImg );  

			await this.saveImage(newImg).then((value:ArrayBuffer)=>{
				this.app.vault.modifyBinary(file,value);
			});
		}

		// get vault config, determine whether useMarkdownLinks is set
		const vaultConfig = getVaultConfig(this.app)
		let useMarkdownLinks = false
		if (vaultConfig && vaultConfig.useMarkdownLinks) 
		{
			useMarkdownLinks = true
		}

		// get origin file link before renaming
		const linkText = this.makeLinkText(originName, useMarkdownLinks, file, sourcePath)

		// file system operation
		const newPath = path.join(file.parent.path, newName)
		try 
		{
			await this.app.fileManager.renameFile(file, newPath)
		} 
		catch (err) 
		{
			new Notice(`Failed to rename ${newName}: ${err}`)
			throw err
		}
		const newLinkText = this.makeLinkText(newName, useMarkdownLinks, this.app.vault.getAbstractFileByPath(newPath) as TFile, sourcePath)
		debugLog('replace text', linkText, newLinkText)

		// in case fileManager.renameFile may not update the internal link in the active file,
		// we manually replace by manipulating the editor
		const editor = this.getActiveEditor()
		if (!editor) 
		{
			new Notice(`Failed to rename ${newName}: no active editor`)
			return
		}

		const cursor = editor.getCursor()
		const line = editor.getLine(cursor.line)
		debugLog('current line', line)
		// console.log('editor context', cursor, )
		editor.transaction({
			changes: [
				{
					from: {...cursor, ch: 0},
					to: {...cursor, ch: line.length},
					text: line.replace(linkText, newLinkText),
				}
			]
		})

		new Notice(`Renamed ${originName} to ${newName}`)
	}

	makeLinkText(fileName: string, useMarkdownLinks: boolean, file: TFile, sourcePath: string): string {
		if (useMarkdownLinks) {
			return this.app.fileManager.generateMarkdownLink(file, sourcePath)
		} else {
			return `[[${fileName}]]`
		}
	}

	// returns a new name for the input file, with extension
	generateNewName(file: TFile, activeFile: TFile) {
		let imageNameKey = ''
		const fileCache = this.app.metadataCache.getFileCache(activeFile)
		if (fileCache) {
			debugLog('frontmatter', fileCache.frontmatter)
			imageNameKey = fileCache.frontmatter?.imageNameKey || ''
		} else {
			console.warn('could not get file cache from active file', activeFile.name)
		}

		const stem = renderTemplate(this.settings.imageNamePattern, {
			imageNameKey,
			fileName: activeFile.basename,
		})
		const meaninglessRegex = new RegExp(`[${this.settings.dupNumberDelimiter}\s]`, 'gm')

		return {
			stem,
			newName: stem + '.' + file.extension,
			isMeaningful: stem.replace(meaninglessRegex, '') !== '',
		}
	}

	// newName: foo.ext
	async deduplicateNewName(newName: string, dirpath: string) {
		
		const listed = await this.app.vault.adapter.list(dirpath)
		debugLog('sibling files', listed)

		// parse newName
		const newNameExt = path.extension(newName),
			newNameStem = path.filename(newName),
			newNameStemEscaped = escapeRegExp(newNameStem),
			delimiter = this.settings.dupNumberDelimiter,
			delimiterEscaped = escapeRegExp(delimiter)

		let dupNameRegex = new RegExp(
				`^(?<name>${newNameStemEscaped})${delimiterEscaped}(?<number>\\d+)`)

		debugLog('dupNameRegex', dupNameRegex)

		const dupNameNumbers: number[] = []
		let isNewNameExist = false
		for (let sibling of listed.files) {
			sibling = path.filename(sibling)
			if (sibling == newNameStem ) 
			{
				isNewNameExist = true
				continue
			}

			// match dupNames
			const m = dupNameRegex.exec(sibling)
			if (!m) continue
			// parse int for m.groups.number
			dupNameNumbers.push(parseInt(m.groups.number))
		}

		if (isNewNameExist) {
			// get max number
			const newNumber = dupNameNumbers.length > 0 ? Math.max(...dupNameNumbers) + 1 : 1
			// change newName
			newName = `${newNameStem}${delimiterEscaped}${newNumber}.${newNameExt}`; 
		}

		return newName
	}

	getActiveFile() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView)
		const file = view?.file
		debugLog('active file', file?.path)
		return file
	}
	getActiveEditor() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView)
		return view?.editor
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

function isPastedImage(file: TAbstractFile): boolean {
	if (file instanceof TFile) {
		if (file.name.startsWith(PASTED_IMAGE_PREFIX)) {
			return true
		}
	}
	return false
}

const IMAGE_EXTS = [
	'jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg',
]

function isImage(file: TAbstractFile): boolean {
	if (file instanceof TFile) {
		if (IMAGE_EXTS.contains(file.extension.toLowerCase())) {
			return true
		}
	}
	return false
}

class SettingTab extends PluginSettingTab {
	plugin: PasteImageRenamePlugin;

	constructor(app: App, plugin: PasteImageRenamePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Png to Jpeg')
			.setDesc(`Paste images from ClipBoard to notes by copying them through various screenshot software, 
			turn on this feature will automatically convert png to jpeg, and more quality compression volume.`)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.pngToJpeg)
				.onChange(async (value) => {
					this.plugin.settings.pngToJpeg = value;
					await this.plugin.saveSettings();
				}
			));	
			
		new Setting(containerEl)
			.setName('Quality')
			.setDesc(`The smaller the Quality, the greater the compression ratio.`)
			.addDropdown(toggle => toggle
				.addOptions({'0.1':'0.1','0.2':'0.2','0.3':'0.3','0.4':'0.4','0.5':'0.5','0.6':'0.6','0.7':'0.7','0.8':'0.8','0.9':'0.9','1.0':'1.0'})
				.setValue(this.plugin.settings.quality)
				.onChange(async (value) => {
					this.plugin.settings.quality = value;
					await this.plugin.saveSettings();
				}
			));				
	}
}
