.PHONY: lint build package check notes tag release

NAME := $(shell node -p "require('./package.json').name")
VERSION := $(shell node -p "require('./package.json').version")
TAG := v$(VERSION)
NOTES_FILE := /tmp/zotero-release-notes.txt
VSIX := $(NAME)-$(VERSION).vsix

lint:
	npm run lint

build:
	npm run compile

package: build
	npx vsce package

check:
	@rg -q "^##\\s+$(VERSION)\\b" CHANGELOG.md

notes:
	@awk '/^##[[:space:]]+'$(VERSION)'\\b/{flag=1;next} /^##[[:space:]]+/{flag=0} flag' CHANGELOG.md > $(NOTES_FILE)

tag:
	git tag -a $(TAG) -m "$(TAG)"

release: check notes package tag
	git push --tags
	gh release create $(TAG) $(VSIX) --notes-file $(NOTES_FILE)
