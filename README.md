# obsidian-paste-png-to-jpeg

This plugin is inspired by [obsidian-paste-image-rename](https://github.com/reorx/obsidian-paste-image-rename), obsidian-paste-image-rename can rename the image when it is inserted, I thought I could also compress and modify it when it is inserted, so I created this plugin

The plugin automatically handles the following points when pasting screenshots to notes
1,Convert the image to jpeg and compress it
2,Store the image in the image folder under the current notes directory
3,Change the image name to the name of the current note plus the number

For example, a screenshot of hello.md will be named hello-1.jpeg...
In addition you can set whether to enable image compression, and set the quality of the image, the smaller the quality, the higher the compression rate.

![](images/settings.png)