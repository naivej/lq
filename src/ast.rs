//! CST types (Deno `ast.ts`). Arena of nodes; identity is [`NodeId`].

/// Index into [`Document::nodes`].
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct NodeId(u32);

impl NodeId {
    pub fn index(self) -> usize {
        self.0 as usize
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NodeKind {
    Document,
    Block {
        tag: String,
        args: Option<String>,
        is_begin_variant: bool,
    },
    Property {
        key: String,
        value: Option<String>,
    },
    Text {
        text: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodeData {
    pub kind: NodeKind,
    pub children: Vec<NodeId>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Document {
    nodes: Vec<NodeData>,
    root: NodeId,
}

impl Document {
    pub fn new() -> Self {
        let mut doc = Self {
            nodes: Vec::new(),
            root: NodeId(0),
        };
        doc.root = doc.alloc(NodeKind::Document);
        doc
    }

    pub fn root(&self) -> NodeId {
        self.root
    }

    pub fn node(&self, id: NodeId) -> &NodeData {
        &self.nodes[id.index()]
    }

    pub fn node_mut(&mut self, id: NodeId) -> &mut NodeData {
        &mut self.nodes[id.index()]
    }

    pub fn alloc(&mut self, kind: NodeKind) -> NodeId {
        let id = NodeId(self.nodes.len() as u32);
        self.nodes.push(NodeData {
            kind,
            children: Vec::new(),
        });
        id
    }

    pub fn push_child(&mut self, parent: NodeId, child: NodeId) {
        self.nodes[parent.index()].children.push(child);
    }

    pub fn set_children(&mut self, id: NodeId, children: Vec<NodeId>) {
        self.nodes[id.index()].children = children;
    }

    pub fn set_kind(&mut self, id: NodeId, kind: NodeKind) {
        self.nodes[id.index()].kind = kind;
    }

    /// Deep copy of `id` and its descendants into new arena slots (Deno `structuredClone`).
    pub fn clone_subtree(&mut self, id: NodeId) -> NodeId {
        let kind = self.node(id).kind.clone();
        let children = self.node(id).children.clone();
        let new_id = self.alloc(kind);
        for child in children {
            let cloned = self.clone_subtree(child);
            self.push_child(new_id, cloned);
        }
        new_id
    }
}

impl Default for Document {
    fn default() -> Self {
        Self::new()
    }
}
