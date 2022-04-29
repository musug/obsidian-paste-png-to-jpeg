import {
  App, Plugin, PluginSettingTab, Setting, TFile, TAbstractFile,
	MarkdownView, Notice, Vault,
} from 'obsidian';

import { renderTemplate } from './template';
import {
   debugLog, path, escapeRegExp, ConvertImage
} from './utils';

interface PluginSettings {
	// {{imageNameKey}}-{{DATE:YYYYMMDD}}
	imageNamePattern: string
	dupNumberAtStart: boolean
	dupNumberDelimiter: string
	autoRename: boolean
	pngToJpeg: boolean
	quality: string
	dirpath: string
}

const DEFAULT_SETTINGS: PluginSettings = {
	imageNamePattern: '{{fileName}}',
	dupNumberAtStart: false,
	dupNumberDelimiter: '-',
	autoRename: true,
	pngToJpeg:true,
	quality:'0.6',
	dirpath:"image/" 
}

const PASTED_IMAGE_PREFIX = 'Pasted image '


export default class PastePngToJpegPlugin extends Plugin {
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

				const timeGapMs = Date.now() - file.stat.ctime;

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

		const newName:string = await this.generateNewName(file, activeFile)

		this.renameFile(file, newName, activeFile.path)
	}

	async renameFile(file: TFile, newName: string, sourcePath: string) {
		// deduplicate name

		const isCreate = await this.app.vault.adapter.exists(this.settings.dirpath);
		if( !isCreate )
		{
			await this.app.vault.createFolder(this.settings.dirpath);
		}

		const originName = file.name;

		if( this.settings.pngToJpeg)
		{
			let binary:ArrayBuffer = await this.app.vault.readBinary(file);
			let imgBlob:Blob = new Blob( [binary] );
			let arrayBuffer:ArrayBuffer = await ConvertImage(imgBlob, Number( this.settings.quality ) );
			this.app.vault.modifyBinary(file,arrayBuffer);
		}

		// get origin file link before renaming
		const linkText = this.makeLinkText(file, sourcePath);

		// file system operation
		const newPath = path.join(file.parent.path, newName);
		try 
		{
			await this.app.vault.rename(file, newPath);
		} 
		catch (err) 
		{
			new Notice(`Failed to rename ${newName}: ${err}`)
			throw err
		}

		const newLinkText = this.makeLinkText(file, sourcePath);
		debugLog('replace text', linkText, newLinkText)

		// in case fileManager.renameFile may not update the internal link in the active file,
		// we manually replace by manipulating the editor
		const editor = this.getActiveEditor( sourcePath );
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

	makeLinkText( file: TFile, sourcePath: string, subpath?:string): string 
	{
		return this.app.fileManager.generateMarkdownLink(file, sourcePath,subpath)
	}

	// returns a new name for the input file, with extension
	async generateNewName(file: TFile, activeFile: TFile):Promise<string>
	{
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

		const newName:string = await this.deduplicateNewName(stem + '.' + file.extension);

		return newName;
	}

	// newName: foo.ext
	async deduplicateNewName(newName: string):Promise<string> 
	{
		
		const listed = await this.app.vault.adapter.list(this.settings.dirpath)
		debugLog('sibling files', listed)

		// parse newName
		const newNameExt = this.settings.pngToJpeg?'jpeg':path.extension(newName),
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

		if (isNewNameExist) 
		{
			// get max number
			const newNumber = dupNameNumbers.length > 0 ? Math.max(...dupNameNumbers) + 1 : 1
			// change newName
			newName = `${this.settings.dirpath}${newNameStem}${delimiterEscaped}${newNumber}.${newNameExt}`; 
		}
		else
		{
			newName = `${this.settings.dirpath}${newNameStem}.${newNameExt}`;
		}

		return newName
	}

	getActiveFile() 
	{
		const view = this.app.workspace.getActiveViewOfType(MarkdownView)
		const file = view?.file
		debugLog('active file', file?.path)
		return file
	}

	getActiveEditor(sourcePath:string) 
	{
		const view = this.app.workspace.getActiveViewOfType(MarkdownView)
		if( view )
		{
			if( view.file.path == sourcePath )
			{
				return view.editor
			}
		}
		return null
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
	'jpg', 'jpeg', 'png'
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
	plugin: PastePngToJpegPlugin;

	constructor(app: App, plugin: PastePngToJpegPlugin) {
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
