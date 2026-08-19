---
jupyter:
  jupytext:
    notebook_metadata_filter: nbsphinx,-kernelspec
    text_representation:
      extension: .md
      format_name: markdown
      format_version: '1.3'
      jupytext_version: 1.14.0
  nbsphinx:
    execute: never
---

# Introduction to Autoencoders

```python
import mygrad as mg
import mynn
import numpy as np

from mygrad.nnet.initializers import he_normal
from mynn.layers.dense import dense
from mynn.losses.mean_squared_loss import mean_squared_loss
from mynn.optimizers.sgd import SGD
from mynn.optimizers.adam import Adam

import matplotlib.pyplot as plt

%matplotlib notebook
```

## 1 Defining a Linear Autoencoder Model


### 1.1 What Exactly Is An Autoencoder?


Autoencoders are a family of neural networks that can be leveraged to learn dense, abstract representations of data. These representations can often be used to make salient important, high-level features about our data. As an example of an encoder network, Facenets's facial-recognition model could take a picture of a face and **encode it** into a 512-dimensional vector that allowed us to tell the difference between individuals based on their personal appearances. 

We can think of an autoencoder as two separate neural nets: an encoder and a decoder. We pass in data to our encoder, which generates a useful, abstract representation for the data. This abstract representation of the data is then passed into the decoder, which will **try to recover the original data**. We train the encoder and decoder simultaneously, with the autoencoder learning to how to compress and uncompress the data in the most lossless way possible.

Autoencoders are a sort of hybrid supervised-unsupervised network. There *is* a truth value, but it is simply the original data (i.e., `ytrain = xtrain`). When the network is trained with `mean_squared_error` loss between the network's outputs and inputs, gradient descent will try to find parameters that result in good encodings (representations with reduced dimensionality) that allow the decoder to recover or reconstruct the original input.

Our entire autoencoder can be used for de-noising data. The learning mapping to a reduced dimension can be used for visualization, clustering, compression, etc.


We'll be training something that is *structured* like neural network with two dense layers, but its "layers" will not have any activation functions nor biases.
Thus this is not a neural network at all: recall that the "neuron" terminology comes from the use of non-linear activation functions! Our auto-encoder simply consists of two matrix multiplications:

\begin{equation}
D_{\mathrm{enc}}(X) = X W_{\mathrm{enc}} \\
D_{\mathrm{dec}}(X) = X W_{\mathrm{dec}} \\
F(W_{\mathrm{enc}}, W_{\mathrm{dec}}; X) = D_{\mathrm{dec}}(D_{\mathrm{enc}}(X)) = X W_{\mathrm{enc}} W_{\mathrm{dec}}
\end{equation}

Assume $X$ represents a batch of $N$ pieces of  input-data, and has a shape `(N, D_full)`. $W_{\mathrm{enc}}$ is responsible has a shape `(D_full, D_hidden)`, $W_{\mathrm{dec}}$ has shape `(D_hidden, D_full)`, and `D_hidden` < `D_full`. The first layer can be thought to "encode" each datum in $X$ into a smaller dimension of size `D_hidden`. The second layer then "decodes" the encoding by mapping it back to the original dimension of size `D_full`:

```
(N, D_full) x (D_full, D_hidden) x (D_hidden, D_full) -> (N, D_full)
```

Thus **our goal** is to find values for values for our encoder-weights and decoder weights such that:

\begin{equation}
F(W_{\mathrm{enc}}, W_{\mathrm{dec}}; X) \approx X
\end{equation}

The reason we restrict ourselves to linear activations is that once when we apply an autoencoder to word embeddings, we will want to maintain linear relationships for visualizing word embedding relationships.

Once we have completely trained our autoencoder, we can simply chop off the decoder and use the encoder to generate our desired dense representations.

Complete the `LinearAutoencoder` MyNN class below.

```python
class LinearAutoencoder:
    def __init__(self, D_full, D_hidden):
        """ This initializes all of the layers in our model, and sets them
        as attributes of the model.
        
        Parameters
        ----------
        D_full : int
            The size of the inputs.
            
        D_hidden : int
            The size of the 'bottleneck' layer (i.e., the reduced dimensionality).
        """
        # Initialize the encoder and decorder dense layers using the `he_normal` initialization
        # schemes.
        # What should the input and output dimensions of each layer be? 
        # <COGINST>
        self.dense1 = dense(D_full, D_hidden, weight_initializer=he_normal, bias=False)
        self.dense2 = dense(D_hidden, D_full, weight_initializer=he_normal, bias=False)
        # </COGINST>
        
    def __call__(self, x):
        '''Passes data as input to our model, performing a "forward-pass".
        
        This allows us to conveniently initialize a model `m` and then send data through it
        to be classified by calling `m(x)`.
        
        Parameters
        ----------
        x : Union[numpy.ndarray, mygrad.Tensor], shape=(M, D_full)
            A batch of data consisting of M pieces of data,
            each with a dimentionality of D_full.
            
        Returns
        -------
        mygrad.Tensor, shape=(M, D_full)
            The model's prediction for each of the M pieces of data.
        '''
        # keep in mind that this is a linear model - there is no "activation function"
        # involved here
        return self.dense2(self.dense1(x)) # <COGLINE>
        
    @property
    def parameters(self):
        """ A convenience function for getting all the parameters of our model.
        
        This can be accessed as an attribute, via `model.parameters` 
        
        Returns
        -------
        Tuple[Tensor, ...]
            A tuple containing all of the learnable parameters for our model """
        return self.dense1.parameters + self.dense2.parameters # <COGLINE>
```

## 2 Our Data


We will use the Iris dataset, in which each datum is a 4-dimensional vector, and train an Autoencoder that will learn to compress the data into a 2-dimensional space. By reducing the dimensionality of the data, we will be able to visually identify clusters within the dataset.

The Iris dataset consists of 150 4-dimensional feature vectors describing three classes of Iris flowers. Each sample is a row vector 
\begin{equation}
\vec{x}=\begin{bmatrix}\text{sepal length} & \text{sepal width} & \text{petal length} & \text{petal width}\end{bmatrix}
\end{equation}

The Iris dataset contains data on three species of Iris. Each species has distinct features, and so should form clusters among the species.

Similar to our work in Week 2, zero center the data and scale by dividing by the standard deviation. Also make sure to check the shape of the data.

```python
from cogworks_data.language import get_data_path

iris = np.load(get_data_path("iris_data.npy"))

# <COGINST>
iris -= np.mean(iris, axis=0)
iris /= np.std(iris, axis=0)
iris.shape
# </COGINST>
```

Let's up a noggin plotter to display the loss metric. Use `max_fraction_spent_plotting=.75`. Note there's no additional accuracy metric since this is a regression problem instead of a classification task.

```python
from noggin import create_plot
plotter, fig, ax = create_plot(metrics=["loss"], max_fraction_spent_plotting=.75)
```

Create a LinearAutoencoder with `D_hidden=2` and train it using MyNN's `mean_squared_loss` as the loass function.
Consider: what is our "truth" here?
Recall that we are training our encoder-decoder network to be able *reproduce* the original data after encoding and then decoding each datum 

You probably will only need 500 or less epochs.
Try using a batch-size of 25.
Use the `SGD` optimizer with the default parameters (e.g. `learning_rate=0.1`).

```python
# <COGINST>
model = LinearAutoencoder(D_full=4, D_hidden=2)

optim = SGD(model.parameters, learning_rate=0.1)

num_epochs = 500
batch_size = 25

for epoch_cnt in range(num_epochs):
    idxs = np.arange(len(iris))
    np.random.shuffle(idxs)
    
    for batch_cnt in range(0, len(iris)//batch_size):
        batch_indices = idxs[batch_cnt*batch_size : (batch_cnt + 1)*batch_size]
        batch = iris[batch_indices]

        prediction = model(batch) 
        truth = batch  # we want our model to reproduce the original input
        
        loss = mean_squared_loss(prediction, truth)
        loss.backward()
        
        optim.step()

        plotter.set_train_batch({"loss" : loss.item()}, batch_size=batch_size)
        
    # epoch loss
    if epoch_cnt % 100 == 0:
        with mg.no_autodiff:
            prediction = model(iris)
            truth = iris
            loss = mean_squared_loss(prediction, truth)
        print(f'epoch {epoch_cnt:5}, loss = {loss.item():0.3f}')
        plotter.set_train_epoch()
# </COGINST>
```

To obtain a reduced-dimensional embedding of a datum **only apply the encoder** to that datum. 
That is, do not perform a full forward pass of your model - instead, only apply the first dense layer to the dataset.
Save the output to the variable `reduced`, which should be a shape-(150, 2) tensor.

```python
with mg.no_autodiff:
    reduced = model.dense1(iris) # <COGLINE>
```

Now use the below code to plot your reduced-dimensionality dataset. The plot will color the three different species of iris included in the dataset.

```python
names = ['iris_satosa', 'iris_versicolor', 'iris_virginica']
colors = ['red', 'green', 'blue']

fig, ax = plt.subplots()
for i in range(3):
    x = reduced[i*50:(i+1)*50, 0]
    y = reduced[i*50:(i+1)*50, 1]
    ax.scatter(x, y, c=colors[i], label=names[i])
ax.grid()
ax.legend()
```

Let's take a moment to think about what our autoencoder is doing here. Just as when we constructed a one-layer dense network for the tendril dataset, which found three linear separators for the three tendrils, our autoencoder is finding a linear separator of the data. Because our hidden layer is 2-dimensional, the linear separator is a 2-dimensional plane in the original 4-dimensional space. The autoencoder then projects the original 4-dimensional data down into 2 dimensions. This projection is what is plotted above.

What information are we now able to deduce from our now reduced data? Taking a step away from NLP, what uses might this dimensionality reduction have in data analysis? Discuss with a partner.
